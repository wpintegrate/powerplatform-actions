// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
"use strict";
const gulp = require('gulp');
const eslint = require('gulp-eslint');
const mocha = require('gulp-mocha');
const ncc = require('@vercel/ncc');
const sourcemaps = require('gulp-sourcemaps');
const ts = require('gulp-typescript');

const fetch = require('node-fetch');
const fs = require('fs-extra');
const log = require('fancy-log');
const path = require('path');
const pslist = require('ps-list');
const unzip = require('unzip-stream');
const { glob } = require('glob');
const { spawnSync } = require('child_process');
const { EOL } = require('os');
const { ta } = require('date-fns/locale');

const tsConfigFile = './tsconfig.json';
const tsconfig = require(tsConfigFile);
const outdir = path.resolve(tsconfig.compilerOptions.outDir);
const distdir = path.resolve('./dist');
const readPAT = process.env['AZ_DevOps_Read_PAT'];

async function clean() {
    (await pslist())
        .filter((info) => info.name.startsWith('pacTelemetryUpload'))
        .forEach(info => {
            log.info(`Terminating: ${info.name} - ${info.pid}...`)
            process.kill(info.pid);
        });
    return fs.emptyDir(outdir);
}

function compile() {
    const tsProj = ts.createProject(tsConfigFile);
    return gulp
        .src('src/**/*.ts')
        .pipe(sourcemaps.init())
        .pipe(tsProj())
        // https://www.npmjs.com/package/gulp-typescript#source-maps
        .pipe(sourcemaps.write('./', { sourceRoot: './', includeContent: false }))
        .pipe(gulp.dest(outdir));
}

async function nugetInstall(nugetSource, packageName, version, targetDir) {
    // https://docs.microsoft.com/en-us/nuget/api/package-base-address-resource
    const feeds = {
        'nuget.org': {
            authenticated: false,
            baseUrl: 'https://api.nuget.org/v3-flatcontainer/'
        },
        'CAP_ISVExp_Tools_Daily': {
            authenticated: true,
            // https://dev.azure.com/msazure/One/_packaging?_a=feed&feed=CAP_ISVExp_Tools_Daily
            baseUrl: 'https://pkgs.dev.azure.com/msazure/_packaging/d3fb5788-d047-47f9-9aba-76890f5cecf0/nuget/v3/flat2/'
        },
    }

    const selectedFeed = feeds[nugetSource];
    const baseUrl = selectedFeed.baseUrl;

    packageName = packageName.toLowerCase();
    version = version.toLowerCase();
    const packagePath = `${packageName}/${version}/${packageName}.${version}.nupkg`;

    const nupkgUrl = new URL(packagePath, baseUrl);
    const reqInit = {
        headers: {
            'User-Agent': 'gulpfile-DAP-team/0.1',
            'Accept': '*/*'
        },
        redirect: 'manual'
    };
    if (selectedFeed.authenticated) {
        if (!readPAT) {
            throw new Error(`nuget feed ${nugetSource} requires authN but env var 'AZ_DevOps_Read_PAT' was not defined!`);
        }
        reqInit.headers['Authorization'] = `Basic ${Buffer.from('PAT:' + readPAT).toString('base64')}`;
    }

    log.info(`Downloading package: ${nupkgUrl}...`);
    let res = await fetch(nupkgUrl, reqInit);
    if (res.status === 303) {
        const location = res.headers.get('location');
        const url = new URL(location);
        log.info(` ... redirecting to: ${url.origin}${url.pathname}}...`);
        // AzDevOps feeds will redirect to Azure storage with location url w/ SAS token: on 2nd request drop authZ header
        delete reqInit.headers['Authorization'];
        res = await fetch(location, reqInit);
    }
    if (!res.ok) {
        throw new Error(`Cannot download ${res.url}, status: ${res.statusText} (${res.status}), body: ${res.body.read().toString('ascii')}`);
    }

    log.info(`Extracting into folder: ${targetDir}`);
    return new Promise((resolve, reject) => {
        res.body.pipe(unzip.Extract({ path: targetDir }))
            .on('close', () => {
                resolve();
            }).on('error', err => {
                reject(err);
            })
    });
}

function lint() {
    return gulp
        .src('src/**/*.ts')
        .pipe(eslint({
                formatter: 'verbose',
                configuration: '.eslintrc.js'
            }))
        .pipe(eslint.format());
}

function test() {
    return gulp
        .src('src/test/**/*.ts', { read: false })
        .pipe(mocha({
                require: [ "ts-node/register" ],
                ui: 'bdd'
            }))
        .pipe(eslint.format());
}

function binplace(compName, relativePath) {
    const targetDir = path.resolve(distdir, relativePath);
    log.info(`Copying ${compName} to ${targetDir}...`);
    fs.emptyDirSync(targetDir);
    fs.copySync(path.resolve(outdir, relativePath), targetDir, {
        filter: (src) => path.extname(src) !== '.pdb'
    });
}

async function populateDist() {
    fs.emptyDirSync(distdir);
    binplace('SoPa', path.join('sopa', 'content', 'bin', 'coretools'));
    binplace('pac CLI', path.join('pac', 'tools'));

    glob.sync('**/action.yml', {
            cwd: __dirname
        })
        .map(actionYaml => path.basename(path.dirname(actionYaml)))
        .forEach((actionName, idx) => {
            const actionDir = path.resolve(distdir, 'actions', actionName)
            log.info(`package action ${idx} "${actionName}" into ./dist folder (${actionDir})...`);
            ncc(path.resolve(outdir, 'actions', actionName), {
                minify: false,
            })
            .then(({code, map, assets}) => {
                fs.emptyDirSync(actionDir);
                fs.writeFileSync(path.resolve(actionDir, 'index.js'), code);
            });
        });
}

function runSilent(exeName, ...args) {
    const cp = spawnSync(exeName, ...args, { cwd: __dirname, encoding: 'utf-8' });
    if (cp.error) {
        throw new Error(`run exe failed: ${cp.error}`);
    }
    const output = cp.output
        .filter(line => !!line)
        .map(line => line.trimEnd());
    return [cp.status, output, cp.stdout, cp.stderr];
}

function run(exeName, ...args) {
    log.info(`running: ${exeName} ${args.join(' ')}`);
    const [status, output, stdout, stderr] = runSilent(exeName, args);
    log.info(`(status: ${status})${EOL}${output.join(EOL)}`);
    return [stdout, stderr];
}

async function setVersion() {
    // https://docs.github.com/en/free-pro-team@latest/actions/reference/environment-variables#default-environment-variables
    const branchName = process.env.GITHUB_REF;
    const workflow = process.env.GITHUB_WORKFLOW;
    const isOfficial = process.env.CI && branchName === 'main' || false;
    const ver = require('./majorMinor.json');
    // https://github.com/adamralph/minver
    let [proposedTag, _] = run('dotnet', 'tool', 'run', 'minver', '--minimum-major-minor', `${ver.major}.${ver.minor}`, '--tag-prefix', 'v', '--default-pre-release-phase', 'preview');
    // e.g.: "0.1.8-preview.0.2"
    const fullVersion = proposedTag.trim();
    log.info(`proposed new version: ${fullVersion}`);
    const tags = [];
    if (isOfficial) {
        tags.push(fullVersion); // for CI builds of main, use the full tag
    } else if (workflow === 'release') {
        tags.push(fullVersion.split('-')[0]);    // for the official release, remove the preview part
    } else {
        log.info('Not tagging local or PR builds');
    }
    const token = process.env.GITHUB_TOKEN;
    const pushToOrigin = token && tags.length > 0;
    if (pushToOrigin) {
        runSilent('git', ['config', '--local', 'http.https://github.com/.extraheader', `AUTHORIZATION: basic ${Buffer.from(`PAT:${token}`).toString('base64')}`]);
    }
    tags.forEach(tag => {
        run('git', 'push', repoUrl, tag);
        if (pushToOrigin) {
            run('git', 'tag', '-f', tag);
        }
    });
    runSilent('git', ['config', '--local', '--unset-all', 'http.https://github.com/.extraheader']);
}

// make them named functions so that gulp -T shows the task graph with actual function names:
async function nugetPac() { await nugetInstall('CAP_ISVExp_Tools_Daily', 'Microsoft.PowerApps.CLI', '1.3.6-daily-20082523', path.resolve(outdir, 'pac')); }
async function nugetSoPa() { await nugetInstall('nuget.org', 'Microsoft.CrmSdk.CoreTools', '9.1.0.49', path.resolve(outdir, 'sopa')); }
async function restoreDotnetTools() { run('dotnet', 'tool', 'restore'); }

const restore = gulp.series(
    clean,
    nugetPac,
    nugetSoPa,
    restoreDotnetTools,
);

const recompile = gulp.series(
    restore,
    compile
);

const dist = gulp.series(
    populateDist,
);

exports.clean = clean;
exports.restore = restore;
exports.compile = compile;
exports.recompile = recompile;
exports.lint = lint;
exports.test = test;
exports.ci = gulp.series(
    recompile,
    lint,
    test
);
exports.dist = dist;
exports.setVersion = setVersion;
exports.default = recompile;
