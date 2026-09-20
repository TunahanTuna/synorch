import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface FileSystem {
  assertPathWithinRoot(rootPath: string, targetPath: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  isDirectory(filePath: string): Promise<boolean>;
  readText(filePath: string): Promise<string>;
  writeText(filePath: string, content: string): Promise<void>;
  list(directoryPath: string): Promise<readonly DirectoryEntry[]>;
}

export class NodeFileSystem implements FileSystem {
  public async assertPathWithinRoot(rootPath: string, targetPath: string): Promise<void> {
    const lexicalRoot = path.resolve(rootPath);
    const lexicalTarget = path.resolve(targetPath);
    assertContainedPath(lexicalRoot, lexicalTarget);

    const canonicalRoot = await realpath(lexicalRoot);
    const relativeTarget = path.relative(lexicalRoot, lexicalTarget);
    let currentPath = lexicalRoot;
    for (const segment of relativeTarget.split(path.sep).filter((value) => value.length > 0)) {
      currentPath = path.join(currentPath, segment);
      try {
        await lstat(currentPath);
      } catch (error: unknown) {
        if (isMissingFileError(error)) break;
        throw error;
      }
      const canonicalPath = await realpath(currentPath);
      assertContainedPath(canonicalRoot, canonicalPath);
    }
  }

  public async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
  }

  public async isDirectory(filePath: string): Promise<boolean> {
    try {
      return (await stat(filePath)).isDirectory();
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
  }

  public readText(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  }

  public async writeText(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }

  public async list(directoryPath: string): Promise<readonly DirectoryEntry[]> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  }
}

function assertContainedPath(rootPath: string, targetPath: string): void {
  const relative = path.relative(rootPath, targetPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root through a symbolic link or junction: ${targetPath}`);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
