/**
 * `node --test packages/relay/test` 的目录入口。
 *
 * Node 24 的 test runner 只把「文件/glob」参数当作测试文件；传入目录时会尝试把
 * <dir>/index.js 作为入口模块加载。这里显式 import 全部测试文件，保证验收命令
 *   node --test packages/relay/test
 * 与
 *   node --test packages/relay/test/*.test.js
 * 行为一致（后者按文件逐个跑，推荐 CI 用 glob）。
 */
import './sni.test.js';
import './tokens.test.js';
import './control.test.js';
import './http.test.js';
import './data-plane.test.js';
