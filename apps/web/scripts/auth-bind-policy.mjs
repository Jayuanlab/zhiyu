export function assertAuthBinding(mode, argv) {
  if (mode && !["local_owner", "authenticated"].includes(mode)) throw new Error("Invalid AUTH_MODE");
  if (mode !== "local_owner") return;
  let hostname;
  for (let i = 0; i < argv.length; i++) {
    if (["-H", "--hostname"].includes(argv[i])) hostname = argv[++i];
    else if (argv[i].startsWith("--hostname=")) hostname = argv[i].slice(11);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error("local_owner requires explicit --hostname 127.0.0.1 (or localhost/::1)");
  }
}
