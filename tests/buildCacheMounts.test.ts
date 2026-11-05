import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perRepoBuildCacheMounts } from "../src/buildCacheMounts.ts";
import { cacheKeyFromPath } from "../src/buildCache.ts";

const remote = "/cache/maven/repository/.mfc-remote";
test("#586 Maven 和 SDK 下载共享，install 与 SDK 解压仍按仓隔离", t => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "mfc-cache-mounts-"));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  const make = (repo: string) => perRepoBuildCacheMounts({
    cacheRoot, cacheKeySource: repo, volumes: [],
    cppSdkDestination: "/work/cpp_sdk_repository",
    seedEnvironment: { MAVEN_OPTS: "-Xmx2g", npm_config_registry: "https://npm.example" },
  });
  const a = make("a");
  const b = make("b");
  const source = (mounts: typeof a, destination: string) =>
    mounts.volumes.find(volume => volume.split(":")[1] === destination)?.split(":")[0];
  assert.ok(source(a, remote));
  assert.equal(source(a, remote), source(b, remote));
  assert.equal(cacheKeyFromPath(cacheRoot, source(a, remote)!), "shared-maven");
  for (const path of ["/cache/maven", "/cache/npm", "/cache/ccache", "/cache/xdg", "/work/cpp_sdk_repository"]) {
    assert.notEqual(source(a, path), source(b, path), path);
  }
  assert.match(a.environment.MAVEN_OPTS!, /-Xmx2g/);
  assert.match(a.environment.MAVEN_OPTS!, /-Dmaven.repo.local=\/cache\/maven\/repository/);
  assert.match(a.environment.MAVEN_OPTS!, /named.factory=file-lock/);
  assert.equal(a.environment.npm_config_registry, "https://npm.example");
  for (const destination of [remote, `${remote}/locks`, "/cache/maven/repository/../repository/.mfc-remote/", "/cache"]) {
    assert.throws(() => perRepoBuildCacheMounts({
      cacheRoot, cacheKeySource: "a", volumes: [`/custom:${destination}`],
    }), /不能覆盖/);
  }
});

test("未配置平台缓存时不改变用户环境或挂载", () => {
  const volumes = ["/custom:/tools:ro"];
  assert.deepEqual(perRepoBuildCacheMounts({ cacheKeySource: "a", volumes,
    seedEnvironment: { MAVEN_OPTS: "-Xmx1g" } }),
  { volumes, environment: { MAVEN_OPTS: "-Xmx1g" } });
});
