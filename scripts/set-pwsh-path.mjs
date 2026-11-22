// set-pwsh-path.mjs — 把 `pwsh-sandbox.pwshPath` 写成指定的绝对路径。
//
// 背景：`@deepseek-ai/dsh-tool-pwsh` 只负责注册 `pwsh` 工具，真正决定跑哪个
// 可执行文件的是执行器 `dsh-pwsh-sandbox`（Windows 上默认 workspace-write）。
// 它的 `pwshPath` 是 `dsh-settings` 的一个 live 字段，所以**不用改 preset**，
// 通过 `settings.update({ns:'pwsh-sandbox', patch:{pwshPath}})` 就能让下一次调用
// 重新探测（dsh-pwsh-local 的 getter 发现 declared 变了就重新 resolve）。
//
// 本脚本不打印任何 Key/Token；只读 config.json 的 dsh.baseUrl 并复用桥接的鉴权。
//
// 用法：
//   node scripts/set-pwsh-path.mjs "C:/Program Files/PowerShell/7/pwsh.exe"
//   node scripts/set-pwsh-path.mjs --show
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../src/dsh-client.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const baseUrl = cfg.dsh?.baseUrl || 'http://127.0.0.1:3080'
const api = new NodeApiClient(baseUrl, 30000, {
  token: cfg.dsh?.authToken || discoverDshLaunchToken(),
  header: cfg.dsh?.authHeader,
  prefix: cfg.dsh?.authPrefix,
})

const arg = process.argv[2]
if (!arg || arg === '--help' || arg === '-h') {
  console.error('用法：node scripts/set-pwsh-path.mjs <pwsh.exe 绝对路径> | --show')
  process.exit(1)
}

if (arg === '--show') {
  const desc = unwrap(await api.settings.describe({}), 'settings.describe')
  const ns = desc.namespaces.find((n) => n.ns === 'pwsh-sandbox')
  console.log(JSON.stringify(ns?.value ?? {}, null, 2))
  process.exit(0)
}

const pwshPath = path.resolve(arg)
if (!fs.existsSync(pwshPath)) {
  console.error(`找不到可执行文件：${pwshPath}`)
  process.exit(1)
}
// 只接受 exe（避免把 .cmd/.ps1 传给 CreateProcess）。
if (!/\.exe$/i.test(pwshPath)) {
  console.error(`pwshPath 必须是 .exe：${pwshPath}`)
  process.exit(1)
}

unwrap(await api.settings.update({ ns: 'pwsh-sandbox', patch: { pwshPath: pwshPath.replace(/\\/g, '/') } }), 'settings.update')
const desc = unwrap(await api.settings.describe({}), 'settings.describe')
const value = desc.namespaces.find((n) => n.ns === 'pwsh-sandbox')?.value ?? {}
console.log(`pwsh-sandbox.pwshPath = ${value.pwshPath}`)
