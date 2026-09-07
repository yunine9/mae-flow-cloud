/** 邀请参与检视不随分析阶段开关；决定卡仍使用各自的审批权限。 */
export function isInvitedReviewParticipant(task: {
  collaborators?: string[];
  requirement_graph?: { repositories: Array<{ assignee?: string }> };
}, username: string | undefined): boolean {
  return !!username && (task.collaborators?.includes(username) === true
    || task.requirement_graph?.repositories.some((repo) => repo.assignee === username) === true);
}
