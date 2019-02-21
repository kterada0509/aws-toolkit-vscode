/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import * as assert from 'assert'
import * as fs from 'fs'
import { promisify } from 'util'

import * as filesystem from '../../shared/filesystem'

const functionsToTest = [
    'access',
    'readFile',
    'readdir',
    'stat',
    'mkdir',
    'mkdtemp',
    'writeFile',
]

describe('filesystem', () => {
    functionsToTest.forEach((fxName: string) => {
        it(`filesystem.${fxName} is same as promisify(fs.${fxName})`, async () => {
            // @ts-ignore missing index signature
            const filesystemFunction = filesystem[fxName]
            // @ts-ignore missing index signature
            const fsFunction = fs[fxName]
            assert.strictEqual(
                String(filesystemFunction),
                String(promisify(fsFunction)) // tslint:disable-line:no-unsafe-any
            )
        })
    })
})
