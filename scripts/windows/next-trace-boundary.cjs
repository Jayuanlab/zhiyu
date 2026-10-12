// Distribution-only preload; do not change Next's installed files or live server.
// NFT's asset glob can recursively visit the whole development drive before its
// ignore callback filters results. Release npm packages are copied in full by
// copyDependencyClosure; app public/manifests/skills have explicit payload paths.
if (process.env.ZHIYU_WINDOWS_DISTRIBUTION !== '1') {
  throw new Error('distribution_trace_preload_requires_distribution_mode');
}
const next = require('next/package.json');
if (next.version !== '16.2.1') throw new Error('distribution_trace_adapter_requires_review_for_next_version');
const nft = require('next/dist/compiled/@vercel/nft');
const trace = nft.nodeFileTrace;
if (typeof trace !== 'function') throw new Error('distribution_trace_api_changed');
Object.defineProperty(nft, 'nodeFileTrace', {
  configurable: true, enumerable: true,
  value: (entries, options = {}) => trace(entries, {
    ...options,
    analysis: { ...(typeof options.analysis === 'object' ? options.analysis : {}), emitGlobs: false },
  }),
});
