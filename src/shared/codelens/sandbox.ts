/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import * as crossSpawn from 'cross-spawn'
import * as fs from 'fs'
import * as path from 'path'
import * as util from 'util'
import * as vscode from 'vscode'
import { SamCliBuildInvocation } from '../sam/cli/samCliBuild'
import { DefaultSamCliProcessInvoker } from '../sam/cli/samCliInvoker'
import { SamCliProcessInvoker } from '../sam/cli/samCliInvokerUtils'

const access = util.promisify(fs.access)
const mkdir = util.promisify(fs.mkdir)

interface PipeTransport {
    pipeProgram: 'sh' | 'powershell'
    pipeArgs: string[]
    debuggerPath: '/tmp/lambci_debug_files/vsdbg',
    pipeCwd: string
}

interface DotNetDebugConfiguration extends vscode.DebugConfiguration {
    type: 'coreclr'
    request: 'attach'
    processId: string
    pipeTransport: PipeTransport
    windows: {
        pipeTransport: PipeTransport
    }
    sourceFileMap: {
        [key: string]: string
    }
}

interface StartDebuggingContext {
    startDebugging: typeof vscode.debug.startDebugging
    invoker: SamCliProcessInvoker
}

interface StartDebuggingArgs {
    runtime: 'dotnetcore2.0' | 'dotnetcore2.1',
    codeUri: vscode.Uri,
    samAppRoot: vscode.Uri
    port: number,
    workspaceFolder: vscode.WorkspaceFolder,
    templatePath: string
}

export async function startDebugging(
    args: StartDebuggingArgs,
    context: StartDebuggingContext = {
        startDebugging: vscode.debug.startDebugging,
        invoker: new DefaultSamCliProcessInvoker()
    }
): Promise<void> {
    await build(args, context)
    await installDebugger(args)
    await invoke()
    await attach(args, context)
}

async function build(
    { templatePath }: Pick<StartDebuggingArgs, 'templatePath'>,
    { invoker }: Pick<StartDebuggingContext, 'invoker'>
): Promise<void> {
    const buildDir = '' // TODO
    const invocation = new SamCliBuildInvocation({
        buildDir,
        environmentVariables: {
            SAM_DEBUG_MODE: 'debug'
        },
        invoker,
        templatePath,
        useContainer: false
    })

    await invocation.execute()
}

async function installDebugger(
    { runtime, codeUri }: Pick<StartDebuggingArgs, 'codeUri' | 'runtime'>
): Promise<void> {
    const vsdbgPath = path.resolve(codeUri.fsPath, '.vsdbg')
    try {
        await access(vsdbgPath)
    } catch {
        await mkdir(vsdbgPath)
    }

    const process = crossSpawn(
        'docker',
        [
            'run',
            '--rm',
            '--mount',
            `type=bind,src=${vsdbgPath},dst=/vsdbg`,
            '--entrypoint',
            'bash',
            `lambci/lambda:${runtime}`,
            '-c',
            '"curl -sSL https://aka.ms/getvsdbgsh | bash /dev/stdin -v latest -l /vsdbg"'
        ],
    )

    await new Promise<void>((resolve, reject) => {
        process.once('close', (code, signal) => {
            if (code === 0) {
                resolve()
            } else {
                reject(signal)
            }
        })
    })
}

async function invoke() {
    // TODO: Once run-without-debugging is implemented, use shared code to invoke.
    // TODO: Once output watching is implemented, listen for 'waiting for debugger
    //       to attach...', and don't return until it is found (or times out).
}

async function attach(
    args: Pick<StartDebuggingArgs, 'codeUri' | 'port' | 'workspaceFolder'>,
    context: StartDebuggingContext
) {
    const config = makeDebugConfiguration(args)
    await context.startDebugging(args.workspaceFolder, config)
}

function makeDebugConfiguration(
    { port, codeUri }: Pick<StartDebuggingArgs, 'port' | 'codeUri'>
): DotNetDebugConfiguration {
    const pipeArgs = [
        '-c',
        `docker exec -i $(docker ps -q -f publish=${port}) \${debuggerCommand}`
    ]
    const debuggerPath = '/tmp/lambci_debug_files/vsdbg'
    const pipeCwd = codeUri.fsPath

    return {
        name: '.NET Core Docker Attach',
        type: 'coreclr',
        request: 'attach',
        processId: '1',
        pipeTransport: {
            pipeProgram: 'sh',
            pipeArgs,
            debuggerPath,
            pipeCwd
        },
        windows: {
            pipeTransport: {
                pipeProgram: 'powershell',
                pipeArgs,
                debuggerPath,
                pipeCwd
            }
        },
        sourceFileMap: {
            ['/var/task']: codeUri.fsPath
        }
    }
}
