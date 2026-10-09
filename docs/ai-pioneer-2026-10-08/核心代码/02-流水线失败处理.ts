    recordTransition(state, {
      source: "platform", note: `流水线失败(${repo})@ ${sha.slice(0, 12)}`,
    });
    // 红=申报打回:清掉申报账,修复后要重新申报再过验绿门。
    delete state.mr_gate;
    // 红灯兜底撤卡(#374,见 dismissStaleGate):推送撤卡(main 路)漏
    // 掉的现场——恢复直挂续表绕过 armPipelineWatch、推送后 AI 同回合
    // 补举的验证卡——到红灯这里必须让失败事实正常送达,不再停靠旧卡。
    this.dismissStaleGate(live, repo, sha, "red");
    // 取证增强:平台失败产物全文镜像进会话工作区 pipeline/,AI 用
    // Bash 读全文再修,而不是只看状态响应里截断 1500 字的摘要。
    // 镜像失败不拦主链路——按摘要修复,文案如实说明没有产物。
    const artifacts = await this.mirrorPipelineArtifactsFor(live, repo, sha);
    const feedbackId = `issue-pipeline:${repo}:${sha}`;
    this.feedbackStore(live).upsert([{
      id: feedbackId,
      batch_id: feedbackId,
      source: "pipeline",
      source_id: `${repo}@${sha}`,
      source_revision: watch.round,
      observed_sha: sha,
      summary: describePipelineRun(run).slice(0, 1000),
      verification: "pipeline",
      status: "repairing",
      updated_at: new Date().toISOString(),
    }]);
    // ---- 红灯切换(#247,ADR-0024):分诊判断交 AI,平台停代举 ----
    // 平台不再评估"可不可修/证据够不够",不再代举 pipeline_unfixable /
    // pipeline_evidence:失败事实(摘要/逐维度明细/产物镜像)三态发送
    // 给 AI,三路处置由它现场判断——能修直接修(同分支重推再建 MR)、
    // 证据缺口举报错回灌卡、不可修告警举人工处理卡,后两路经 raise_gate
    // (平台复核红灯在案)。平台保留机械三样:同提交刹车(防空转循环)、
    // 修复轮预算(发送回合=修复回合,派了才 +1,耗尽诚实停机)、留痕
    // (反馈账与转移账)。证据重试窗随分诊编排一并退场:产物镜像仍在
    // 红灯当下做一次,AI 凭现场事实判断,平台不再定时重评。
    const checks = run.checks ?? watch.checks;
    const max = repairBudget(this.options.settings);
    // ① 同提交刹车(需求流 last_sha===sha→halted 同语义):红灯还是
    // 上次派发修复的同一提交=修了没出新提交,再发送同一份事实只会
    // 原地打转——停机不投:reds 不变(不耗预算),会话最后一次发言
    // (AI 的诊断)写进留痕与通知,"把 AI 的诊断交给我"。人的
    // resume_watch 重看豁免刹车(作答时清刹车账):人声明平台侧已
    // 处理,重看仍红按新红灯重新发送。
    if (watch.last_repair_sha && watch.last_repair_sha === sha) {
      const diagnosis = (state.last_reply ?? "").trim();
      const note = `流水线红灯仍是上次派发修复的同一提交(${sha.slice(0, 12)})`
        + "——修复没有产出新提交,已停机不再派发修复,请人工处理";
      watch.last_error = note;
      state.stage_note = diagnosis
        ? `${note};AI 最后诊断: ${diagnosis.slice(0, 300)}`
        : `${note}(会话没有留下诊断发言)`;
      recordTransition(state, {
        source: "platform",
        note: diagnosis
          ? `同提交刹车(${repo})@ ${sha.slice(0, 12)}:自动修复停机,`
            + `AI 诊断: ${diagnosis.slice(0, 300)}`
          : `同提交刹车(${repo})@ ${sha.slice(0, 12)}:自动修复停机`
            + "(会话没有留下诊断发言)",
      });
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 同提交刹车(${repo})`
        + ` @ ${sha.slice(0, 12)},reds 保持 ${watch.reds ?? 0},`
        + `${diagnosis ? "带 AI 诊断停机" : "无诊断发言停机"}`);
      this.notifyPipelineStopped(live,
        `pipeline_repair_brake:${repo}:${sha}`,
        `${this.issueSubject(live)}:仓 ${repo} 流水线红灯仍是上次派发修复的`
          + `同一提交(${sha.slice(0, 12)}),修复没有产出新提交,自动修复`
          + "已暂停。"
          + (diagnosis
            ? `修复会话的诊断: ${diagnosis.slice(0, 600)}`
            : "修复会话没有留下诊断发言。")
          + "请人工查看 MR/流水线,处理后发消息继续");
      return;
    }
    // ② 修复轮预算(与需求侧同一管理页旋钮 repair_rounds,缺省 20):
    // 发送回合就是修复回合——AI 在里面或修或举卡,派了才记一轮,绿了
    // 清零;超限停止自动发送,请人工处理后发消息继续。预算 0=完全
    // 人工(第一次红灯也停机)——举卡也是判断,判断发生在发送回合
    // 里,没有"不派回合先举卡"的旁路。
    const reds = (watch.reds ?? 0) + 1;
    watch.reds = reds;
    if (reds > max) {
      watch.last_error =
        `流水线红灯修复轮预算耗尽(${max} 轮),请人工查看流水线`;
      state.stage_note = `流水线连续 ${reds} 次红灯,修复轮预算(${max} 轮)`
        + "已耗尽——请人工查看 MR/流水线;处理后发消息继续";
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 流水线修复轮预算耗尽(${repo},`
        + `${reds}/${max}) @ ${sha.slice(0, 12)}`);
      // 放弃点通知(需求侧 notifyRepairStopped 同语义):预算烧完就是
      // "机器放弃、该人接手"的时刻,主动喊人。同因(同仓同提交)再
      // 停机凭 outcome 通道幂等不重发。
      this.notifyPipelineStopped(live,
        `pipeline_repair_exhausted:${repo}:${sha}`,
        `${this.issueSubject(live)}:流水线连续 ${reds} 次红灯,修复轮预算`
          + `(${max} 轮)已耗尽,自动修复已放弃。请人工查看 MR/流水线,`
          + "处理后发消息继续");
      return;
    }
    // ③ 派发修复记账:本轮提交与红灯摘要落账——下一轮"换新提交"红灯时
    // 作为上轮报错拼进发送词(先写账再发送,进程死在两行之间也只是
    // 多记一轮,不会把账记到没派过的提交头上)。
    const previousSha = watch.last_repair_sha;
    const previousSummary = watch.last_failure_summary;
    watch.last_repair_sha = sha;
    watch.last_failure_summary = pipelineFailureDigest(run, checks);
    saveState(live.root, state);
    // ④ 失败事实发送(三态:运行中 steer/等人落便签/空闲开回合)。
    // 逐维度明细与镜像产物都给全——判断交 AI,材料也交全。
    this.startPlatformTurn(live, [
      promptCopy("notices", "red.deliver.header", { repo, reds, max }),
      "",
      // 分支头是平台外提交(ADR-0041):红灯属于别人推的提交——材料
      // 开头先交底,修复指引让 AI 先拉最新代码、看差异再动手。
      ...(watch.external_head
        ? [promptCopy("notices", "red.deliver.external_head",
            { sha: sha.slice(0, 12) }), ""]
        : []),
      "**失败摘要**",
      "",
      describePipelineRun(run),
      "",
      "**逐维度明细**(含工具)",
      "",
      ...(checks?.length ? summarizeFailedChecks(checks)
        : ["(平台未返回逐维度明细)"]),
      "",
      "**镜像产物**",
      "",
      artifacts.length
        ? `失败产物全文已镜像到会话工作区 pipeline/ 目录(${artifacts.join("、")}),先用 Bash 读全文再判断。`
        : "平台未返回本次失败产物,可按上方摘要与各维度链接判断,"
          + "或到交付平台的 MR/流水线页面查看。",
      ...(previousFailureLines(previousSha, previousSummary)
        .flatMap((line, index) => index === 0 ? ["", line] : [line])),
      "",
      promptCopy("notices", "red.deliver.guidance", { repo }),
    ].join("\n"));
    this.log(`[issue-flow] ${live.id} 流水线红灯(${repo})`
      + `@ ${sha.slice(0, 12)},第 ${reds}/${max} 轮:失败事实已发送`
      + "(分诊交 AI)");
  }
