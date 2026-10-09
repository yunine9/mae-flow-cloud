  /** 同一次操作预检全部已选建议，再按意图提交正式库与文稿，归档由人另行触发。 */
  publish(id: string, input: ComponentPublishInput, operator: string): ResearchRecord {
    if (this.stopped) throw new Error("服务正在停止");
    const record = this.records.get(id);
    if (!record || record.challenge || record.deleted_at || record.status !== "done") throw new Error("请等待组件草稿完成后发布");
    if (record.publication_intent) { this.finishPublication(record); return this.get(id); }
    if (!object(input) || input.document_id !== (record.document_id ?? null) || input.update_document_id !== (record.update_document_id ?? null)
      || input.update_document_revision !== record.update_document_revision) throw new Error("正式知识绑定或版本已变化，请刷新后发布");
    const accepted = structuredClone(record);
    delete accepted.production; delete accepted.publication_intent;
    const selected = record.document?.sections.filter(section => section.selected) ?? [];
    if (!Array.isArray(input.sections) || input.sections.length !== selected.length || new Set(input.sections.map(item => item?.id)).size !== selected.length
      || input.sections.some(item => !object(item) || !selected.some(section => section.id === item.id))) throw new Error("请选择完整且不重复的组件清单，刷新后重新发布");
    if (record.document && !selected.length) throw new Error("请选择至少一个已完成组件");
    for (const section of selected) {
      const viewed = input.sections.find(item => item.id === section.id)!;
      assertReviewRevision(section.revision, viewed.revision, "章节已有新版本，请比较后重新发布");
      const latest = [...record.review_turns ?? []].reverse().find(turn => turn.section_id === section.id && turn.proposal?.status === "pending");
      if (!Object.hasOwn(viewed, "proposal_id") || viewed.proposal_id !== (latest?.id ?? null)) throw new Error("组件修改建议已有变化，请重新检视后发布");
      if (!latest) continue;
      assertLatestReviewProposal(reviewProposals(record), latest.id, section.id, section.revision, false,
        "修改建议基线冲突，请比较章节最新版本后发布");
      const document = editResearchDocument(accepted.document!, { action: "section", section: structuredClone(latest.proposal!.section) },
        (record.components ?? [record.component]).map(component => component.id));
      const metadata = document.sections.find(item => item.id === section.id)?.paradigm;
      if (metadata) {
        if (metadata.language !== record.language) throw new Error("范式语言与研究语言不一致");
        for (const ref of metadata.evidence) if (!record.evidence.some(evidence => evidence.tool === "component_source" && evidence.action === "read" && evidence.status === "returned"
          && evidence.component_id === ref.repository_id && evidence.path === ref.path && evidence.revision === ref.revision
          && Number(evidence.start) <= ref.start && Number(evidence.end) >= ref.end)) throw new Error("引用必须对应本任务已读取的基础仓代码范围");
        for (const evidenceId of metadata.usage_evidence) if (!record.evidence.some(evidence => evidence.evidence_id === evidenceId && evidence.tool === "code_search"
          && evidence.action === "read" && evidence.status === "returned" && evidence.content)) throw new Error("调用证据必须对应本任务已取得的 everycode 原文");
      }
      (accepted.section_history ??= []).push({ at: new Date().toISOString(), operator, section: structuredClone(section) });
      accepted.document = document;
      for (const turn of accepted.review_turns ?? []) if (turn.section_id === section.id && turn.proposal?.status === "pending") turn.proposal.status = turn.id === latest.id ? "accepted" : "discarded";
    }
    assertNoPendingReviewProposals(reviewProposals(accepted), selected.map(section => section.id));
    if (accepted.document?.sections.some(section => section.selected && !sectionReady(section))) throw new Error("请选择已完成且含最佳示例的组件");
    const formalId = record.document_id ?? record.update_document_id;
    const previous = formalId ? readKnowledgeDocument(this.dir, formalId) : undefined;
    const baseline = record.update_document_id ? record.update_document_revision : record.published_revision;
    if (previous && (!baseline || previous.revision !== baseline)) throw new Error("正式知识已有新版本，请比较最新内容后发布，未覆盖他人修改");
    const title = String(input.title ?? previous?.title ?? record.topic).trim();
    const content = accepted.document ? researchDocumentMarkdown(title, accepted.document, true) : String(input.content ?? accepted.draft ?? "");
    scanForSecrets("组件知识.md", Buffer.from(content));
    const research_source = { job_id: id, repository: record.component.repository, branch: record.component.branch, path: record.component.path,
      revision: record.revision, components: record.components?.map(component => ({ id: component.id, repository: component.repository,
        branch: component.branch, path: component.path, revision: record.revisions?.[component.id] })) };
    const formal = prepareKnowledgeDocument(this.dir, { ...previous, ...input, title, content, technologies: [record.language], research_source,
      when_to_use: input.when_to_use ?? previous?.when_to_use ?? `${record.language} / ${record.topic}`, active: previous?.active ?? true,
    }, operator, formalId, { expectedRevision: baseline, maxContentBytes: accepted.document ? 16 * 1024 * 1024 : undefined });
    Object.assign(accepted, { document_id: formal.document.id, published_revision: formal.document.revision, update_document_id: undefined,
      update_document_revision: undefined, update_metadata: { title: formal.document.title, scope: formal.document.scope,
        module_ids: formal.document.module_ids, repositories: formal.document.repositories },
      stage: "已入库", draft: accepted.document ? researchDocumentMarkdown(title, accepted.document) : content });
    const intent: ComponentPublicationIntent = { formal, record: accepted };
    this.commitPublicationRecord({ ...structuredClone(record), publication_intent: intent });
    this.finishPublication(this.records.get(id)!);
    return this.get(id);
  }
  recoverPublications() {
    for (const record of [...this.records.values()]) {
      if (!record.publication_intent || record.deleted_at) continue;
      try { this.finishPublication(record); }
      catch (error) {
        const warning = `组件发布未完成：component-research/${record.id}/record.json；${error instanceof Error ? error.message : "请检查发布意图"}`;
        if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
      }
    }
  }
  private commitPublicationRecord(record: ResearchRecord) {
    const { production: _, ...raw } = record;
    mkdirSync(this.root(record.id), { recursive: true });
    durableWriteFileSync(join(this.root(record.id), "record.json"), JSON.stringify(raw), { mode: 0o600 });
    this.records.set(record.id, raw);
  }
  private finishPublication(record: ResearchRecord) {
    const intent = record.publication_intent!;
    let current: ReturnType<typeof readKnowledgeDocument> | undefined;
    try { current = readKnowledgeDocument(this.dir, intent.formal.document.id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current && current.revision !== intent.formal.document.revision && current.revision !== intent.formal.previous_revision) throw new Error("正式知识已有新版本，发布意图未覆盖其他人的修改");
    // 人工恢复旧正文会复用内容版本号，但历史已前进；不能把它误当尚未提交的原基线。
    if (current && current.revision !== intent.formal.document.revision
      && JSON.stringify(current.history) !== JSON.stringify(intent.formal.document.history.slice(0, -1))) {
      throw new Error("正式知识已有人工修改或恢复历史，发布意图未覆盖其他人的修改");
    }
    if (current?.revision !== intent.formal.document.revision) writePreparedKnowledgeDocument(this.dir, intent.formal);
    // 相同正式版本的重复发布不应重复触发正式库变更回调。
    if (!intent.formal.unchanged) this.onAdopt();
    this.commitPublicationRecord(structuredClone(intent.record));
  }
