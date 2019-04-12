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
import { CloudFormation } from '../cloudformation/cloudformation'
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

interface DotNetCoreDebugConfiguration extends vscode.DebugConfiguration {
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

interface DebugHandlerContext {
    startDebugging: typeof vscode.debug.startDebugging
    invoker: SamCliProcessInvoker
    loadTemplate: typeof CloudFormation.load
}

interface DebugHandlerArgs {
    port: number,
    workspaceFolder: vscode.WorkspaceFolder,
    templatePath: string,
    handlerName: string
}

export async function debugHandler(
    args: DebugHandlerArgs,
    context: DebugHandlerContext = {
        startDebugging: vscode.debug.startDebugging,
        invoker: new DefaultSamCliProcessInvoker(),
        loadTemplate: CloudFormation.load
    }
): Promise<void> {
    const resource = await getResourceFromTemplate(args, context)

    await build(args, context)
    await installDebugger(resource)
    await invoke()
    await attach({ ...args, resource }, context)
}

async function build(
    { templatePath }: Pick<DebugHandlerArgs, 'templatePath'>,
    { invoker }: Pick<DebugHandlerContext, 'invoker'>
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

async function installDebugger(resource: CloudFormation.Resource): Promise<void> {
    const runtime = getRuntime(resource)
    const codeUri = getCodeUri(resource)
    const vsdbgPath = path.resolve(codeUri, '.vsdbg')

    try {
        await access(vsdbgPath)

        // vsdbg is already installed.
        return
    } catch {
        // We could not access vsdbgPath. Swallow error and continue.
    }

    try {
        await mkdir(vsdbgPath)

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
    } catch {
        // TODO: rm -rf vsdbgPath
    }
}

async function invoke() {
    // TODO: Once run-without-debugging is implemented, use shared code to invoke.
    // TODO: Once output watching is implemented, listen for 'waiting for debugger
    //       to attach...', and don't return until it is found (or times out).
}

async function attach(
    args: Pick<DebugHandlerArgs, 'port' | 'workspaceFolder'> & { resource: CloudFormation.Resource },
    context: DebugHandlerContext
) {
    const config = makeDebugConfiguration(args)
    await context.startDebugging(args.workspaceFolder, config)
}

function makeDebugConfiguration(
    { port, resource }: Pick<DebugHandlerArgs, 'port'> & { resource: CloudFormation.Resource }
): DotNetCoreDebugConfiguration {
    const pipeArgs = [
        '-c',
        `docker exec -i $(docker ps -q -f publish=${port}) \${debuggerCommand}`
    ]
    const debuggerPath = '/tmp/lambci_debug_files/vsdbg'
    const codeUri = getCodeUri(resource)

    return {
        name: '.NET Core Docker Attach',
        type: 'coreclr',
        request: 'attach',
        processId: '1',
        pipeTransport: {
            pipeProgram: 'sh',
            pipeArgs,
            debuggerPath,
            pipeCwd: codeUri
        },
        windows: {
            pipeTransport: {
                pipeProgram: 'powershell',
                pipeArgs,
                debuggerPath,
                pipeCwd: codeUri
            }
        },
        sourceFileMap: {
            ['/var/task']: codeUri
        }
    }
}

function getRuntime(resource: CloudFormation.Resource): string {
    if (!resource.Properties || !resource.Properties.Runtime) {
        throw new Error('Resource does not specify a Runtime')
    }

    return resource.Properties!.Runtime!
}

function getCodeUri(resource: CloudFormation.Resource): string {
    if (!resource.Properties || !resource.Properties.CodeUri) {
        throw new Error('Resource does not specify a CodeUri')
    }

    return resource.Properties!.CodeUri
}

async function getResourceFromTemplate(
    { templatePath, handlerName }: Pick<DebugHandlerArgs, 'templatePath' | 'handlerName'>,
    context: Pick<DebugHandlerContext, 'loadTemplate'>
): Promise<CloudFormation.Resource> {
    const template = await context.loadTemplate(templatePath)

    if (!template.Resources) {
        throw new Error(`Could not find a SAM resource for handler ${handlerName}`)
    }

    const resources = template.Resources
    const matches = Object.keys(resources)
        .filter(key =>
            !!resources[key] && resources[key]!.Type === 'AWS::Serverless::Function' &&
            !!resources[key]!.Properties && resources[key]!.Properties!.Handler === handlerName
        ).map(key => resources[key]!)

    if (matches.length < 1) {
        throw new Error(`Could not find a SAM resource for handler ${handlerName}`)
    }

    if (matches.length > 1) {
        // TODO: Is this a valid scenario? It won't be once we're template-first.
        throw new Error(`Found more than one SAM resource for handler ${handlerName}`)
    }

    return matches[0]
}
