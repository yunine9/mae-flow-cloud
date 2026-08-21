import { spawn, type ChildProcess } from "node:child_process";
import type {
  TaskCommandContainer,
  TaskContainerFactory,
  TaskContainerFactoryInput,
} from "../../src/taskService.ts";

export interface FakeContainerRecord {
  name: string;
  workspace: string;
  started: boolean;
  stopped: boolean;
  stopCalls: number;
  commands: string[];
}

/** Docker daemon 不应成为编排单测的前提。这一后端仍真实执行普通的
 * fixture shell 命令，同时给长构建提供可由 stop/Abort 终止的挂起点。 */
export class FakeTaskContainerHarness {
  readonly records: FakeContainerRecord[] = [];
  readonly events: string[] = [];

  readonly factory: TaskContainerFactory = (
    input: TaskContainerFactoryInput,
  ): TaskCommandContainer => {
    const record: FakeContainerRecord = {
      name: input.name,
      workspace: input.workspace,
      started: false,
      stopped: false,
      stopCalls: 0,
      commands: [],
    };
    this.records.push(record);
    const children = new Set<ChildProcess>();
    const held = new Set<() => void>();

    return {
      start: async () => {
        record.started = true;
        this.events.push(`start:${record.name}`);
      },
      exec: async (command, cwd, options) => {
        if (!record.started || record.stopped) {
          throw new Error(`fake container ${record.name} is not running`);
        }
        record.commands.push(command);
        this.events.push(`exec:${record.name}:${command}`);
        if (command.includes("__MFC_HOLD__")) {
          options.onData(Buffer.from("build is running\n"));
          return await new Promise<{ exitCode: number | null }>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              held.delete(finish);
              resolve({ exitCode: null });
            };
            held.add(finish);
            options.signal?.addEventListener("abort", finish, { once: true });
          });
        }
        return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
          const child = spawn("sh", ["-lc", command], {
            cwd,
            env: { ...process.env, ...(options.env ?? {}) },
            stdio: ["ignore", "pipe", "pipe"],
          });
          children.add(child);
          child.stdout?.on("data", options.onData);
          child.stderr?.on("data", options.onData);
          let timer: NodeJS.Timeout | undefined;
          const terminate = () => child.kill("SIGKILL");
          if (options.timeout) {
            timer = setTimeout(terminate, options.timeout);
            timer.unref?.();
          }
          options.signal?.addEventListener("abort", terminate, { once: true });
          child.once("error", (error) => {
            children.delete(child);
            if (timer) clearTimeout(timer);
            reject(error);
          });
          child.once("close", (code) => {
            children.delete(child);
            if (timer) clearTimeout(timer);
            resolve({ exitCode: code });
          });
        });
      },
      stop: async () => {
        record.stopCalls += 1;
        if (record.stopped) return;
        record.stopped = true;
        this.events.push(`stop:${record.name}`);
        for (const finish of [...held]) finish();
        for (const child of children) child.kill("SIGKILL");
      },
    };
  };
}
