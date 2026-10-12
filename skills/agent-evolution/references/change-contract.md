# 可复用变更记录

这是平台无关的记录模板；字段名可映射到目标系统已有契约，不要求重建数据库。不存在的 ID 或回执留空并说明缺口。

```yaml
changeId: <stable id>
target: <agent or shared component>
scope: <tasks and consumers affected>
baseVersion: <actual loaded version or content hash>
authorization: <user instruction or existing policy reference>
observation:
  window: <time and sampling scope>
  evidenceRefs: []
  facts: []
  unknowns: []
diagnosis:
  layer: <goal|observation|state|context|tool|verification|runtime|governance>
  hypothesis: <falsifiable cause>
  alternatives: []
candidate:
  patch: <exact diff or component revision>
  predictedFix: <scenario, metric, baseline and threshold>
  regressionGuards: []
  attributionLimit: <none or coupled changes>
evaluation:
  scenarios: []
  runtimeContract: <model, tools, data and budgets>
  actualResults: []
  verdict: <not_tested|confirmed|partial|rejected|inconclusive>
rollout:
  state: <draft|validated|approved|applied|observing|retained|reverted>
  receipt: <actual command or version reference>
  loadedReadback: <evidence or not checked>
rollback:
  baselineRef: <exact saved state>
  triggers: []
  restoreProcedure: <actual supported mechanism>
  sideEffectReconciliation: <needed or not applicable>
learning:
  validConditions: []
  counterexamples: []
  recheckWhen: <drift, dependency changes or next observation window>
```

这些是建议状态，不是每个平台都必须采用的固定状态机。状态转换要有实际证据：保存候选不等于上线；加载成功不等于行为改善；单测通过不等于生产成功。

对共享组件记录消费者和版本集合。并发修改发生时重新读取、比较、重新评估；不要覆盖别人较新的改动。批量修改保存逐项回执，部分失败需明确列出；不得把非事务性批处理声明为全部原子成功。

诊断与变更可分开记录：合理的问题可能需要权限授权、基础设施修复或用户决策，不能为了显示“已进化”强行改 prompt。
