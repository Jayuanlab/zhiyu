import base from './vitest.config.ts';
export default {...base,test:{...base.test,setupFiles:[],include:['tests/integration/runtime-lifecycle.test.mjs'],fileParallelism:false,coverage:{enabled:false}}};
