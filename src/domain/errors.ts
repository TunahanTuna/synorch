export class CliError extends Error {
  public readonly exitCode: number;

  public constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
