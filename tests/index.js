import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { rules, configs } from '../lib/index'

const ruleNames = fs.readdirSync(path.resolve(__dirname, '../lib/rules/'))
  .filter(f => path.extname(f) === '.js')
  .map(f => path.basename(f, '.js'))

describe('all rule files should be exported by the plugin', () => {
  ruleNames.forEach((ruleName) => {
    it(`should export ${ruleName}`, () => {
      assert({}.hasOwnProperty.call(rules, ruleName))
    })
  })
})

describe('configurations', () => {
  ruleNames.forEach((ruleName) => {
    it(`should have a recommended configuration for ${ruleName}`, () => {
      assert({}.hasOwnProperty.call(configs.recommended.rules, `meteor/${ruleName}`))
    })
  })
})
