    const record = driver.options.humanGate.createWaiting({
      taskId: driver.options.taskId,
      step: driver.options.currentStep?.() ?? "",
      callId,
      questionInput: (driver.options.prepareHumanQuestion ?? ((input) => input))({ questions,
        ...(params.purpose ? { purpose: params.purpose } : {}),
        ...(params.annotation_ids ? { annotation_ids: params.annotation_ids } : {}),
      }),
      context: explicitContext ?? lastSaid,
      // Agent 常在举卡前把完整清单说在正文里,卡的 context 只写
      // "以上/上述…"——卡上必须带得到那个"上述",不能让人回翻
      // 现场流水(MFC-028 盲签)。context 缺席时 lastSaid 已经当
      // context 用了,不重复。
      preface: explicitContext && lastSaid
        && lastSaid !== explicitContext ? lastSaid : undefined,
    });
    // 重建会话可能把同一个工具调用重放出来。waiting_id 以
    // task+call_id 幂等；若盘上的决定已经 resolved，就把原答案
    // 直接作为本次工具结果回放，绝不能再把它包装成一张新待办。
    // 用户实测的症状正是:子任务已生成，父分析单却又出现同一张卡。
    if (record.status === "resolved") {
      const finished = driver.emit("tool_finished", driver.sessionId, {
        call_id: callId,
        name: "AskUserQuestion",
        input: params ?? {},
        is_error: false,
        result: renderAgentDecision(record),
        answers: answersOf(record, record),
      });
      driver.trackKernelHook(driver.options.hostHooks?.postTool?.(finished));
      driver.hostAnswered.add(callId);
      driver.options.log?.(
        `任务 ${driver.options.taskId} 重放已完成待办 ${record.waiting_id},不重复举卡`);
      return {
        content: [{ type: "text", text: renderAgentDecision(record) }],
        details: {},
      };
    }
    if (record.status === "superseded") {
      const text = `这张旧问题已失效：${record.notes || "现场已更新"}。请读取 mae-flow current 和已记录的用户回答，`
        + "按当前要求继续；不要重复询问已获回答的问题。";
      const finished = driver.emit("tool_finished", driver.sessionId, {
        call_id: callId,
        name: "AskUserQuestion",
        input: params ?? {},
        is_error: true,
        result: text,
      });
      driver.trackKernelHook(driver.options.hostHooks?.postTool?.(finished));
      driver.hostAnswered.add(callId);
      driver.options.log?.(
        `任务 ${driver.options.taskId} 拒绝重放已失效待办 ${record.waiting_id}`);
      return {
        content: [{ type: "text", text }],
        details: {},
        isError: true,
      };
    }
    driver.waitingRecord = record;
    const decision = new Promise<string>((resolve) =>
      driver.decisionResolvers.set(callId, resolve));
    driver.waitingSignal.resolve({
      status: "waiting_for_human", waiting: { ...record },
    });
    const text = await decision; // 会话挂起点:决定到达前 pi 停在这里
    return { content: [{ type: "text", text }], details: {} };
  }
