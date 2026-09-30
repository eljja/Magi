# oh-my-magi 0.2.0 통합 배포 기록

2026-09-30. 사용자가 최신 구현을 기존 npm 이름 **oh-my-magi**로 통합해 게시하도록 명시했습니다. 검증과 npm 게시 요청을 마쳤으며 현재 npm이 요구한 계정 추가 인증을 기다립니다. 인증 완료와 레지스트리 확인 전까지 게시 완료로 표시하지 않습니다.

## 배포 대상

- 최신 지속 운영 소스: `packages/oh-my-openmagi`, npm 이름 `oh-my-magi`, 버전 `0.2.0`.
- 이전 `packages/oh-my-magi`는 `oh-my-magi-legacy`라는 비공개 workspace로 보존합니다. 두 패키지를 동시에 게시하지 않습니다.
- OmO 4.19.4를 원본 의존성으로 사용합니다. 공개 CLI는 `oh-my-magi`이며 `omm`과 이전 개발명은 CLI 별칭입니다.
- 현재 패키지의 자기 등록 허용, OmO/Magi 중복 등록 검사, 모든 CLI 별칭의 사용자 제어 보호를 이름 통합에 맞게 수정했습니다.
- 기존 OpenMagi 데이터·환경변수·설정 경로를 유지합니다. 0.1.x의 목표 상태는 자동 승계하지 않으며, 이전 호스트를 중지하고 설치 전환 후 목표를 다시 입력합니다. 회의·보고 문서는 백업합니다.

## 이번 버전의 검증

통합 후 새로 생성한 tarball을 기준으로 검사합니다.

| 검사 | 결과 |
| --- | --- |
| 패키지 타입 검사 | 통과 |
| 테스트 | **64개 통과, 282개 assertion, 실패 0개** |
| 빌드·tarball·새 환경 설치·CLI·plugin export | 통과 |
| OpenCode 1.18.29 | 통과 |
| OpenCode 1.18.31 | 통과 |
| 현재 최신 OpenCode 1.18.33 | 통과 |
| npm 공개 게시·레지스트리 재다운로드 비교 | 실제 게시 요청 후 npm 본인 인증 대기 |
| 공개 npm에서 native plugin 명령으로 최초 설치 | 대기 |

세 버전 모두 실제 OpenCode 실행 파일과 원본 OmO를 사용하며, 모델 응답은 결정적인 로컬 fixture입니다. Magi primary/숨김 council 3개 등록, 원래 OmO 에이전트 정의 보존, 세 표 의결과 잘못된 표 재시도, 실제 `task → specialist → read/LSP`, 검증 후 다음 회의, 정기 보고, native 프로세스 강제 종료 후 자동 복구와 명시적 중지 유지가 검사 대상입니다. 보고 시험은 12초 간격으로 수행합니다. 이번 게시 검증에서 실제 GUI 화면을 새로 조작하거나 실제 외부 LLM 장기 시험을 수행했다고 주장하지 않습니다.

OmO는 검증한 **4.19.4**로 고정합니다. 의존성 감사에서 기존 `@babel/core` Low 권고 `GHSA-4x5r-pxfx-6jf8` 1건을 확인했으며 문서화된 미패치 예외입니다. 새 Moderate/High/Critical 권고는 해당 검사에서 확인되지 않았습니다.

게시 후보 SHA-256: `c16f531fb12bdfad9a5768ce721547e7550804271136e4168b492377bb84312f`.

CI와 게시 workflow도 최신 구현으로 연결했습니다. 최소 버전과 실행 시점의 npm 최신 OpenCode를 검사하며, 비공개 runtime 디렉터리 대신 정리된 결과 파일만 보관합니다.

검증 증거는 `packages/oh-my-openmagi/artifacts/runs/`에 보존합니다. 타입·테스트·pack·audit 명령은 종료 코드 0이며, 각 native 시험은 정리 후 `passed` 결과를 기록했습니다. 이를 감싼 `verify` 프로세스는 마지막 native 자식이 종료된 뒤 출력 수집 대기에 남아 소유권을 확인하고 종료했습니다. 따라서 `bun run verify` 전체 명령이 정상 종료했다고 기록하지 않으며, 게시 전 검사는 같은 tarball과 소스 해시에 연결된 개별 검사 결과를 모두 다시 확인합니다.

- 타입·테스트·pack·audit 실행: `2026-09-30T13-04-23-475Z-qualification-582ddd99`.
- 1.18.29: `2026-09-30T13-05-40-423Z-native-smoke-fc92c32c`.
- 1.18.31: `2026-09-30T13-10-19-223Z-native-smoke-382f8321`.
- 1.18.33: `2026-09-30T13-08-20-616Z-native-smoke-a7bf0290`.

**이번 배포본은 6시간 구동 평가를 진행하지 않았습니다. 다른 프로젝트의 장기 평가 기록은 이번 배포의 통과 증거나 게시 조건으로 사용하지 않습니다.** 이번 검사에서 직접 확인한 결과만 아래에 기록합니다.

## 게시·설치

게시 완료 후 사용할 최초 설치 명령:

```sh
opencode plugin oh-my-magi@0.2.0 --global
```

기존 OmO/Magi 환경은 이전 목표와 호스트를 중지하고 다음 명령으로 등록을 백업·전환합니다.

```sh
bun install --global oh-my-magi@0.2.0
oh-my-magi install --global --project /대상/프로젝트
```

프로젝트에도 별도 등록이 있으면 `--global` 없이 전환합니다. OpenCode를 재시작해 Magi를 선택하고 목표를 입력합니다. Git은 필수가 아니며 LLM 연결은 OpenCode에 별도로 설정합니다.
