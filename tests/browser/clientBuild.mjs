import fs from 'node:fs';
import path from 'node:path';

// The files the client build is made from (see vite.config.mjs).
const CLIENT_SOURCES = ['index.html', 'vite.config.mjs', 'src', 'public'];

function newestFile(entry) {
    let stat;
    try {
        stat = fs.statSync(entry);
    } catch {
        return null;
    }
    if (!stat.isDirectory()) return { file: entry, mtimeMs: stat.mtimeMs };
    let newest = null;
    for (const name of fs.readdirSync(entry)) {
        const found = newestFile(path.join(entry, name));
        if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
    }
    return newest;
}

// The build a spec's own server.js serves: NEXTRA_TEST_DIST_DIR when it names
// one, else the project's dist, which the shared Playwright web server builds
// before the run. That build is skipped when the web server is reused (a server
// already on its port), and in a lane worktree dist is a link to another
// checkout's build, so dist can hold an older client than the source beside it.
// A spec served such a build fails as if the app had regressed, so a dist older
// than any client source file is refused instead.
export function clientBuildDir(projectRoot) {
    if (process.env.NEXTRA_TEST_DIST_DIR) return path.resolve(process.env.NEXTRA_TEST_DIST_DIR);
    const distDir = path.join(projectRoot, 'dist');
    const fix = 'Run npm run build, or set NEXTRA_TEST_DIST_DIR to a build of this source.';
    let builtAt;
    try {
        builtAt = fs.statSync(path.join(distDir, 'index.html')).mtimeMs;
    } catch {
        throw new Error(`There is no client build in ${distDir}. ${fix}`);
    }
    for (const source of CLIENT_SOURCES) {
        const newest = newestFile(path.join(projectRoot, source));
        if (newest && newest.mtimeMs > builtAt) {
            throw new Error(
                `The client build in ${distDir} is older than ${path.relative(projectRoot, newest.file)}, `
                + `so it would test an older client than this source. ${fix}`,
            );
        }
    }
    return distDir;
}
