/**
 * `node --test packages/relay/test` 的目录入口。
 *
 * Node 24 的 test runner 只把「文件/glob」参数当作测试文件；传入目录时会尝试把
 * <dir>/index.js 作为入口模块加载。这里显式 import 全部测试文件，保证验收命令
 *   node --test packages/relay/test
 * 与
 *   node --test packages/relay/test/*.test.js
 * 行为一致（后者按文件逐个跑，推荐 CI 用 glob）。
 *
 * 0.3.0 起只保留群体版测试：classic 的 data-plane / sni / push / limits / tokens 文件存储
 * 测试已随功能删除（tokens.test.js 现在只覆盖 hostId / host token 生成辅助）。
 * 0.3.1 新增服务端集中推送：push.test.js（配置/服务）、push-control.test.js（控制面往返）。
 * 0.4.0（R2）删除 official 转发：push 测试只覆盖 self（hub 客户端测试已随功能删除）。
 */
import './tokens.test.js';
import './control.test.js';
import './http.test.js';
import './edge-tunnel-head.test.js';
import './group-registration.test.js';
import './group-auth.test.js';
import './group-admin.test.js';
import './group-surfaces.test.js';
import './group-tunnel.test.js';
import './group-env-config.test.js';
import './push.test.js';
import './push-control.test.js';
