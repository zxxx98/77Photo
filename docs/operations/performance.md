# 大图库与低资源验证

`tests/performance` 提供可重复的索引查询基准。它生成固定时间分布、单用户单文件夹的 SQLite 索引，不创建图片文件，因此结果表示数据库与游标分页成本；缩略图解码应单独测量。

在 x86 或 ARM64 主机上运行建议数据集：

```bash
mkdir -p artifacts/performance
/usr/bin/time -v go run ./tests/performance -count 10000 -pages 20 -output artifacts/performance/10000.json
/usr/bin/time -v go run ./tests/performance -count 100000 -pages 20 -output artifacts/performance/100000.json
```

基准输出首个冷查询、相同筛选条件的热查询、连续游标分页耗时和 Go 堆分配。`/usr/bin/time -v` 的最大常驻内存、CPU 时间和系统规格必须与 JSON 一起保存；每次测试先删除旧的 `artifacts/performance` 文件，避免混淆结果。默认缩略图 worker 为 1，基准不会启动后台 worker。

建议在 NanoPi R5S（或记录实际型号、内存和内核版本的 ARM64 设备）上各运行一次，并在服务进程同时执行：空闲 10 分钟、连续滚动图库、生成 256/512/1280 三档缩略图、管理员 rescan。记录空闲和峰值 RSS、首屏及后续分页 p50/p95、扫描耗时、缩略图队列长度和 CPU 温度。没有 ARM64 实机时，报告必须明确标记“实机验收未完成”，不能把桌面机数据当作设备结论。

本次基准在 ARM64 Oracle Neoverse-N1（4 vCPU、约 24 GiB RAM，Linux 6.17）运行，属于可记录规格的 ARM64 设备，不代表 NanoPi R5S：

| 索引条数 | 冷首屏 | 热首屏 | 连续 20 页 | 进程 VmHWM |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 1.402 ms | 1.006 ms | 24.243 ms | 24,832 KB |
| 100,000 | 1.260 ms | 0.970 ms | 24.030 ms | 26,188 KB |

数据由 `go run ./tests/performance` 于 2026-09-12 生成，页大小 50，单用户单文件夹，`captured_at` 每秒递减；表格只覆盖索引查询，不包含真实缩略图、上传或 rescan 的设备负载。`VmHWM` 是基准进程的高水位 RSS，未计入容器和其他服务。

工程目标是空闲约 300 MB、浏览约 500 MB；它们是需要实测的参考值，不是服务的硬性承诺。若超出目标，报告应同时记录数据量、缓存冷热状态、并发上传数和是否启用了外部反向代理，并指出下一步的索引或缓存限制措施。
