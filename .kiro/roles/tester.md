# 能力：tester

## 职责

执行任务卡 `acceptance_criteria` 里 `check_type: "scripted"` 声明的可执行验证（脚本、命令、DB 重验证等），汇报 pass/fail 及证据（命令、输出、退出码）。

## 与 reviewer 的区别

`reviewer` 核对产出是否满足 requirements/design/tasks/steering 的意图和约束，属于判断性评审；`tester` 只负责把声明好的验证步骤真正跑一遍并如实汇报结果，属于执行性验证。同一个任务可以同时要求 `reviewer` 和 `tester` 两个能力，二者的 verdict/结果分别记录，不互相替代。

## 边界

- 只运行任务卡或 `acceptance_criteria` 明确声明的验证步骤，不擅自扩大验证范围到未声明的资源。
- 涉及共享资源（如某个数据库连接）的验证，必须先检查资源锁，遵守写窗口和只读要求。
- 测试结果如实记录，不因为想让任务通过而隐瞒失败项。

## 绑定方式

由 spec 的 `bindings.json` 的 `capabilities.tester` 或 `review_pools.<stage>.seats` 中标注 `capability: "tester"` 的 seat 指定。没有 `bindings.json` 的 spec 沿用现有 loop 文件里对验证步骤的描述。
