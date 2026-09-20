import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface FileSystem {
  exists(filePath: string): Promise<boolean>;
  isDirectory(filePath: string): Promise<boolean>;
  readText(filePath: string): Promise<string>;
  writeText(filePath: string, content: string): Promise<void>;
  list(directoryPath: string): Promise<readonly DirectoryEntry[]>;
}

export class NodeFileSystem implements FileSystem {
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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
