## Context

`RegPtType` 枚举已扩展 `RobotRecordAndVisioned`（机器人记录位置 + 视觉识别方向）和 `RobotRecordAngUnRegnize`（机器人记录位置 + 视觉方向识别失败）。字典策略框架已建立，新增场景只需新建 Calculator 类并在构造函数中注册，无需修改已有代码。

## Goals / Non-Goals

**Goals:**
- 为 `RobotRecordAndVisioned` 的三种组合（双端、仅起点、仅终点）各新增一个 Calculator 类
- `RobotRecordAngUnRegnize` 复用已有 `RobotRecord` Calculator（注册相同实例，不新增类）
- 在 `CapturePointManager` 构造函数中追加新组合的字典注册

**Non-Goals:**
- 不修改已有 Calculator 类
- 不修改 `GetMapMatrixAsync` 主流程
- 不处理 `RobotRecordAndVisioned` 与 `RobotRecord`/`RobotRecordAngUnRegnize` 的混合组合（超出当前需求）

## Decisions

### 1. `RobotRecordAndVisioned` 的位置与方向分离处理

位置取自机器人记录（`FromRecord2Vec`，与原 `RobotRecord` 相同），法向量取自视觉识别的新 VCM。

### 2. 起终点法向量独立提取

法向量从各端点的新 VCM 独立提取：分别调用 `GetNormalFromVcm(wsg, StNewVcm)` 和 `GetNormalFromVcm(wsg, EdNewVcm)` 获取各自的 `(masterNormal, sideNormal)`，不再合并平均。6 个向量参数传入 `CalcCoordinateMatrix(stMn, stSn, stPt, edMn, edSn, edPt)` 返回 `IMapCalculator`。

### 3. `RobotRecordAngUnRegnize` 直接映射到现有 Calculator

`RobotRecordAngUnRegnize` 表示视觉方向识别失败，回退策略等同于纯 `RobotRecord`（位置来自记录，方向由 VCM 推算）。因此注册时直接将 `RobotRecordAngUnRegnize` 键映射到已有 `BothRobotRecordCalculator`、`StartRobotRecordCalculator`、`EndRobotRecordCalculator` 实例，无需新建类。

| stType | edType | Calculator |
|--------|--------|------------|
| `RobotRecordAndVisioned` | `RobotRecordAndVisioned` | `BothRobotRecordVisionedCalculator`（新建） |
| `RobotRecordAndVisioned` | `Visioned` | `StartRobotRecordVisionedCalculator`（新建） |
| `Visioned` | `RobotRecordAndVisioned` | `EndRobotRecordVisionedCalculator`（新建） |
| `RobotRecordAngUnRegnize` | `RobotRecordAngUnRegnize` | `BothRobotRecordCalculator`（复用） |
| `RobotRecordAngUnRegnize` | `Visioned` | `StartRobotRecordCalculator`（复用） |
| `Visioned` | `RobotRecordAngUnRegnize` | `EndRobotRecordCalculator`（复用） |

## Risks / Trade-offs

- **`RobotRecordAndVisioned` 与 `RobotRecord` 混合组合未注册** → 运行时抛出 `NotSupportedException`；后续可按需添加
- **视觉 VCM 质量决定法向量精度** → 与 `Visioned` 场景相同风险，非本次新引入

## Migration Plan

仅追加新类和注册行，无破坏性变更，无需迁移。
