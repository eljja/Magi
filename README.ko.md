# Magi / oh-my-magi

**목표 하나를 저장하고 OpenCode 안에서 연구·개발을 계속하는 플러그인입니다.**

[English](README.md) · [설치·운영 가이드](packages/oh-my-magi/README.md) · [공개 준비 점검표](docs/RELEASE-AUDIT.md)

MELCHIOR가 작업을 제안하고 MELCHIOR·BALTHASAR·CASPER가 검토합니다. 승인한 작업은 Sisyphus가 OpenCode 도구로 실행합니다. 검증 명령과 별도 LLM 리뷰를 모두 통과해야 마일스톤을 완료로 기록합니다.

기본 동작에는 **반복 횟수 제한이 없습니다**. 초기 마일스톤을 마쳐도 원래 목표에 대한 후속 연구를 계속합니다. 일시적 오류나 합의 실패는 일정 시간 후 재검토하며, 사용자가 `/magi stop`으로 중지할 수 있습니다.

## 설치

2026-09-08 확인 시점에는 npm에 아직 게시되지 않았습니다. 게시 후 사용할 공개 설치 명령은 다음과 같습니다.

```sh
opencode plugin oh-my-magi
```

현재 소스로 설치하려면 Bun과 OpenCode **1.18.29**를 준비하고 다음을 실행합니다.

```sh
git clone https://github.com/eljja/Magi.git
cd Magi
bun install --ignore-scripts
cd packages/oh-my-magi
bun run build
bun bin/cli.ts install --local --project /absolute/path/to/your/project
```

프로젝트에서 OpenCode를 다시 열고 모델/provider를 설정한 뒤 시작합니다.

```text
/magi start 연구 파이프라인의 재현성과 정확도를 계속 개선해
/magi status
/magi stop
/magi resume
```

`magi` 에이전트의 `magi_start` 도구로도 시작할 수 있습니다. 에이전트를 선택하기만 해서는 자동 반복이 시작되지 않습니다. Magi 전용 API 키는 필요하지 않으며 OpenCode에 연결된 모델을 사용합니다. 로컬 LLM도 OpenCode provider로 연결할 수 있습니다.

## 운영과 지원 범위

- 목표·세션·로드맵·진행 상태를 `.magi/`에 저장합니다. 재시작 후 해당 프로젝트가 로드되면 저장된 작업을 이어받습니다.
- 서버가 종료되거나 컴퓨터가 꺼지면 연구도 멈춥니다. 무인 운용에는 계속 실행 중인 OpenCode 서버가 필요합니다.
- 검증 명령이 없거나 리뷰가 실패하면 완료로 기록하지 않습니다. 연구 프로젝트와 모노레포는 [검증 명령 설정](packages/oh-my-magi/README.md#verification)을 먼저 확인하세요.
- 실제 OpenCode `1.18.29`에서 설치, 에이전트 등록, 두 실행 검증 후 3번째 사이클 진입, 중지를 로컬 테스트 provider로 검증했습니다.
- CLI·데스크톱·웹은 공통 서버 기능을 사용합니다. 전용 상태 패널은 TUI용이며 GUI·웹에 동일한 위젯을 추가하지 않습니다. 웹 프로젝트·세션 열기, Magi 선택, /magi status 실행까지 확인했습니다. 데스크톱 앱, 재연결, 장시간 실제 모델 실행은 남은 검증 항목입니다.

## OmO와의 관계

현재 코드는 OmO의 역할 구성을 참고한 **독립 구현**입니다. 최신 oh-my-openagent 엔진을 포함하거나 동일한 기능을 제공하는 것은 아닙니다. 확인 시점의 npm 안정판은 `oh-my-opencode@4.19.4`, beta는 `5.0.0-beta.48`입니다. [기반 구성과 호환성 기록](docs/RELEASE-AUDIT.md#upstream-and-omo)을 확인하세요.

저장소에 남아 있는 예전 OpenCode 포크와 `packages/magi-opencode-plugin`은 별도 경로입니다. 기존 플러그인과 `oh-my-magi`를 함께 로드하면 충돌할 수 있으므로 [마이그레이션 절차](packages/oh-my-magi/README.md#migrating-from-the-legacy-magi-plugin)를 따르세요.

npm 게시, 실제 모델 장시간 실행, TUI·데스크톱·웹 수동 QA는 아직 완료했다고 주장하지 않습니다. 수정 내용과 남은 공개 조건은 [공개 준비 점검표](docs/RELEASE-AUDIT.md)에 기록합니다.
