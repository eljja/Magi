# oh-my-magi

<p align="center">
  <img src="assets/magi-execution.svg" alt="의회 표결과 지속적인 자기 개선을 표현한 Magi 오리지널 컨셉 이미지" width="900">
</p>

**Magi에게만 업무를 지시하고, 세 인격이 심의하며, 기존 OmO가 실제로 수행합니다.**

`oh-my-opencode@4.19.4`를 그대로 사용하는 OpenCode 플러그인입니다. 최신 지속 운영 구현을 **oh-my-magi 0.2.1**으로 통합합니다. 소스는 [packages/oh-my-openmagi](packages/oh-my-openmagi)에 있으며, 이전 구현은 비공개 레거시 workspace로 보존합니다.

- GUI/TUI 선택 목록에는 **Magi 한 개**를 추가합니다. Melchior·Balthasar·Casper는 숨겨진 실제 하위 에이전트입니다.
- 세 인격의 초기 의견과 최종 표를 각각 받고, 세 유효 표가 모인 뒤 2표 이상 찬성이면 실행합니다. 구체적인 보안·데이터 손실 위험은 보완 후 재심의합니다.
- Sisyphus·Hephaestus·Prometheus·Atlas 중 적합한 기존 주 에이전트가 실제 OmO 도구와 전문가를 이용해 수행합니다.
- 개별 응답이나 업무가 끝나도 목표는 유지됩니다. 오류는 대기·재시도로 처리하며, 사용자의 명시적 중지로만 운영 의사를 바꿉니다.
- 투표·누적 이력·상세 의견은 기존 문서창에서 보는 Markdown으로 제공합니다. 추가 UI를 설치하지 않습니다.
- 기본 **1시간마다** 작업 중에도 현재 상황을 보고합니다. 명령이나 한국어 대화로 간격을 바꿀 수 있습니다.

[English](README.md) · [설치·전체 설정](packages/oh-my-openmagi/README.md) · [0.2.1 통합 배포 기록](docs/OH-MY-MAGI-0.2.0.ko.md) · [확정한 설계](docs/OH-MY-OPENMAGI.ko.md)

<p align="center">
  <img src="assets/magi-council.svg" alt="MELCHIOR-1, BALTHASAR-2, CASPER-3로 구성된 Magi 삼원 의회 컨셉" width="760">
</p>

## npm 설치·이전 버전 전환

처음 설치하는 환경에서는 다음 명령을 사용합니다.

```sh
opencode plugin oh-my-magi@0.2.1 --global
```

이미 OmO나 구버전 Magi가 등록되어 있다면 이전 목표와 호스트를 중지한 후 설치 도구로 전환합니다.

```sh
bun install --global oh-my-magi@0.2.1
oh-my-magi install --global --project /대상/프로젝트
```

프로젝트에도 별도 등록이 있다면 같은 명령에서 `--global`을 빼고 한 번 더 실행합니다. 설치 도구가 기존 등록을 백업·정리하고 모델 설정을 보존합니다. OmO는 의존성으로 자동 설치되므로 별도 서버 플러그인으로 중복 등록하지 않습니다. OpenCode를 재시작하고 **Magi**를 선택해 목표를 말하세요. LLM 연결은 OpenCode에 설정되어 있어야 하며 Git은 필수가 아닙니다.

0.1.x의 목표 상태는 새 형식으로 자동 재개하지 않습니다. 기존 회의·보고 파일은 백업하며, 새 Magi에 목표를 다시 입력합니다. 개발명 OpenMagi의 상태 경로와 `.magi/openmagi.jsonc`는 그대로 유지합니다. npm 설치 이름은 **oh-my-magi**이며 `omm`은 포함된 CLI 별칭입니다.

## 현재 소스로 시작

Bun 1.3.13 이상, OpenCode 1.18.29 이상·2 미만이 필요합니다.

```sh
bun install --ignore-scripts
cd packages/oh-my-openmagi
bun run build
bun dist/cli.js install --project /대상/프로젝트 --plugin /Magi/packages/oh-my-openmagi/절대경로
```

OpenCode를 재시작하고 **Magi**를 선택해 목표를 입력합니다. 예전 OmO/Magi 등록은 설치 도구가 백업하고 정리하며, 모델 설정은 보존합니다. 전역 설치를 전환할 때는 `--global`을 추가합니다.

현재 공개 배포 대상은 **oh-my-magi 0.2.1**입니다. 정확한 게시·검증 상태는 [통합 배포 기록](docs/OH-MY-MAGI-0.2.0.ko.md)을 확인하세요.

## 자주 쓰는 명령

| 명령 | 동작 |
| --- | --- |
| `/magi stop` / `/magi resume` | 목표 중지 / 재개 |
| `/magi status` | 저장된 실제 상태 |
| `/magi report interval 1h` | 보고 간격 변경 |
| `/magi report now` | 즉시 보고 |
| `/magi report status` | 보고 주기와 다음 시각 |

“보고 간격을 30분으로 줄여”, “이제 네 시간마다 보고해도 돼”, “지금 진행 상황 알려줘”도 지원합니다.

`.magi/VOTES-LATEST.md`에서 현재 투표를, `.magi/VOTES.md`에서 같은 형식의 누적 이력을 봅니다. 각 의견은 한 줄로 기록하고 🟢 찬성·🔴 반대·🟡 보완 요청·대기를 구분합니다. 자세한 근거는 `.magi/COUNCIL.md`, 최신 진행 보고는 `.magi/LATEST-REPORT.md`에 남습니다.

## GUI와 독립적으로 운영

```sh
bun dist/cli.js serve --project /대상/프로젝트
bun dist/cli.js attach --project /대상/프로젝트
```

감독 프로세스가 자신의 OpenCode 서버를 감시하고 복구합니다. 운영체제 시작 등록용 파일은 `service files` 명령으로 생성합니다. 실제 등록 절차는 [설치 문서](packages/oh-my-openmagi/README.md#keep-running-independently-of-the-gui)를 참고하세요. PC가 꺼진 동안 실행할 수는 없으며, 저장 상태와 OS 서비스가 복귀 후 재개를 담당합니다.

이번 배포본의 테스트와 실제 OpenCode 통합 시험은 [통합 배포 기록](docs/OH-MY-MAGI-0.2.0.ko.md)에 구분합니다. 다른 프로젝트의 장시간 평가 결과를 이 배포본의 검증 근거로 사용하지 않습니다. GUI 파일 자동 갱신은 사용하는 뷰어에 따라 달라집니다.

자체 코드는 MIT, 포함하는 원본 OmO 의존성은 SUL-1.0입니다. [라이선스 안내](packages/oh-my-openmagi/THIRD-PARTY-NOTICES.md)를 확인하세요. [기존 제품 문서](README.legacy.ko.md)와 [기존 패키지](packages/oh-my-magi)는 보존했습니다.
