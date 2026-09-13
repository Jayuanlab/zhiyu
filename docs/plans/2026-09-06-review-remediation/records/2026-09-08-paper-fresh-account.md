# 新模拟账户与收盘价建仓

用户明确授权：放弃旧模拟账户恢复，建立空仓新账户，初始资金 1,000,000 元；按 2026-09-08 收盘价买入 515980 共 10,300 份、002716 共 400 股。

- 新账户：`8bfd2ed8-dd4d-5c6c-9690-e066122b60db`。
- 腾讯行情：515980.SH 1.017 元（行情时间 16:14:36+08:00）；002716.SZ 10.61 元（16:14:27+08:00）。原始结果保存在 `tools/quant-service/data/paper_accounts/bootstrap-20260908/quotes.json`。
- 两笔合计 14,719.10 元，现金 985,280.90 元；沿用现有账本不计手续费规则。
- 先以现有导入服务建立空仓账户，再以独立 `owner_close_price_bootstrap` 幂等命令写入两笔订单、成交和持仓。盘后录入时间如实记录，备注明确为用户指定收盘价模拟建仓，没有修改实时撮合时段限制。
- 旧 JSON 保留，并备份至同目录 `legacy-before-reset.json`；没有审核或迁移旧账户的未解释差额。
- 配置独立受限 PostgreSQL 登录角色、服务签名和账户绑定，持久化在忽略版本控制的本地环境文件；凭据不进入记录。
- 复用生产构建 71，无前端源码修改，无重新构建。首次启动因原宿主租约尚未过期退出；等待租约自然到期后重启成功，未强制改租约。

## 回测记录

1. 账本校验：现金守恒、成交/订单/持仓一致；两笔成交、两个持仓，通过。
2. 同一命令再次调用，返回原回执，未重复入账，通过。
3. 中文备注读回完整，通过。
4. `/api/quant/paper/account` HTTP 200，PostgreSQL 新账户、`migrationRequired=false`、现金及数量正确。
5. `/api/runtime/bootstrap` HTTP 200，宿主在线，`paper-matching` 最近运行成功、无错误；旧 `paper_migration_required` 已消除。
6. API 证据：`apps/web/.tmp/production-restart-71/paper-verification.json`；账本快照与回执：`tools/quant-service/data/paper_accounts/bootstrap-20260908/result.json`。
7. 生产网页 `/quant` 浏览器检查通过：两个证券代码均可见，无页面异常；证据 `paper-browser.json`、`paper-account.png` 位于上述生产检查目录。首次测试误按两位小数查找现金文本而超时，页面实际按整数金额显示；修正定位后通过，精确余额由 API 独立校验。

边界：这是用户指定的初始模拟建仓，不是交易时段自动撮合验收。当前自选行情快照不含这两个持仓，账户展示价格回退至成本价；未来持仓估值行情覆盖仍需后续完善，不能据此认定实时估值链路全部通过。
