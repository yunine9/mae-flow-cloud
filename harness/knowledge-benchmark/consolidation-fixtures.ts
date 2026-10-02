export const consolidationFixtures = [
  {id:'complete-coverage',documents:[
    {title:'上传协议',content:'# 上传协议\n\n## 分片\n每片最多 4096 字节；提交前计算 SHA256。\n\n## 取消\n用户取消时调用 abortUpload(token)，不能把部分上传标记成功。'},
    {title:'上传失败处理',content:'# 上传失败处理\n连接中断后先 queryUpload(token) 核对已收到的分片，不能重新提交已经确认的分片。\n服务端不支持断点续传时，需要重新开始独立上传。'},
  ],facts:['4096','SHA256','abortUpload','queryUpload','不支持断点续传'],conflict:false},
  {id:'unresolved-conflict',documents:[
    {title:'批处理说明 A',content:'# 批处理\n产品 4.0 的默认 batch_limit 是 120。资料未经其他来源确认。'},
    {title:'批处理说明 B',content:'# 批处理\n产品 4.0 的默认 batch_limit 是 240。无法确定两份说明谁是最新的，不能按文件顺序选一个。'},
  ],facts:['120','240','batch_limit'],conflict:true},
];
