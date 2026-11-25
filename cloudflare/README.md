# Cloudflare에서 1분마다 검사 시작

GitHub 예약은 쓰지 않습니다. Cloudflare Worker `court-watch`가 1분마다 깨어납니다. 이미 돌고 있거나 대기 중인 `check.yml`이 있으면 새 실행을 넣지 않습니다. 검사는 코트 화면 대신 예약 API를 읽고, 코트마다 동시에 요청합니다.

Worker 코드는 `cloudflare/worker.js`와 같습니다. 주소 `https://court-watch.jinid231.workers.dev/` 를 열면 `fetch() function`이 없다는 오류가 남습니다. 그 주소는 페이지가 아니고, 검사는 크론으로만 돕니다.

## 지금 들어가 있는 값

- Cloudflare 계정: `Jinid231@gmail.com`
- 계정 주소: `https://dash.cloudflare.com/a8e017624370611f7b8d189e1c78d89a/workers/services/view/court-watch/production/settings`
- Worker 이름: `court-watch`
- Cron Triggers: `* * * * *` (Runs every minute)
- 비밀값: `GITHUB_TOKEN` 하나. 종류는 Secret
- Bindings: 없음. KV와 ntfy 값은 Worker에 넣지 않습니다
- 토큰 값 자체는 여기 적지 않습니다. Cloudflare 비밀값에만 있습니다

## 다시 만들 때

1. Cloudflare 무료 계정으로 로그인합니다. 카드와 도메인은 필요 없습니다. 처음이면 메일 인증이 끝나야 Worker를 만들 수 있습니다.
2. Workers & Pages → Create → Workers. 이름은 `court-watch`.
3. Edit code에 `cloudflare/worker.js` 내용을 넣고 Deploy 합니다.
4. Settings → Runtime variables and secrets → Production → + Add variable.
   - 이름: `GITHUB_TOKEN`
   - Type: Secret
   - 값은 아래 GitHub 토큰
5. 같은 Worker의 Cron Triggers에서 Add. 식은 `* * * * *`. 화면에는 Runs every minute 으로 보입니다. 저장합니다.
6. GitHub에서 `check.yml`은 `workflow_dispatch`만 둡니다. `schedule`은 넣지 않습니다. 이 저장소 `main`이 그 상태입니다.

GitHub 토큰:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
2. Repository access는 Only select repositories, 저장소는 `ProjectJJU/CourtWatch`만.
3. Permissions에서 보이는 빈 목록은 계정 권한입니다. Actions는 거기에 없습니다.
4. Repository permissions에서 Add permissions → `Actions` → Read and write.
5. Expiration은 가장 긴 쪽으로 둡니다. 이 종류는 최대 약 1년입니다. 만료되면 토큰을 새로 만들어 Worker 비밀값만 바꿉니다.
6. `github_pat_`로 시작하는 값은 만들 때 한 번만 보입니다. Worker의 `GITHUB_TOKEN`에 넣고, 채팅이나 이 저장소에는 넣지 않습니다.

ntfy는 Worker가 보내지 않습니다. 검사가 GitHub 비밀값 `NTFY_TOPIC`, `NTFY_SERVER`, `NTFY_TOKEN`을 읽습니다. 휴대폰 설치와 그 비밀값을 찾는 위치는 `ntfy.md`에 있습니다.

## Firestore

설정과 검사 기록은 git에 커밋하지 않습니다. `courtwatch/config`와 `courtwatch/state` 두 문서를 Firestore에 둡니다. 설정 페이지는 Google 로그인으로 `config`를 읽고 씁니다. 검사는 서비스 계정으로 `state`를 쓰고, 코트 이름이 바뀐 경우에만 `config`를 고칩니다. `config` 문서가 없으면 첫 검사가 저장소의 `config.yaml`을 올립니다. 그 파일은 시드로 저장소에 남고, 그 다음부터의 설정은 Firestore만 봅니다. `state/slots.json`은 저장소에 넣지 않습니다.

Firebase 프로젝트는 Planner와 Tracker(`local-web-92324`, `core-robotics-sw`)와 따로 만듭니다. Spark 무료 한도를 같이 쓰지 않기 위해서입니다. 전화 인증, Cloud Functions, Storage는 쓰지 않습니다.

1. Firebase 콘솔에서 프로젝트를 만들고 Firestore를 만듭니다. 위치는 쓰는 리전으로 둡니다.
2. Authentication에서 Google 로그인을 켭니다. 승인된 도메인에 GitHub Pages 호스트와, 로컬에서 볼 때는 `localhost`를 넣습니다.
3. 프로젝트 설정의 웹 앱 값 여섯 개(`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`)를 `web/firebase-config.js`에 넣습니다. 이 값들은 페이지에 그대로 나가고 비밀키가 아닙니다. 비어 있으면 설정 페이지는 "Firebase가 설정되지 않았습니다"에서 멈춥니다.
4. `firestore.rules`의 이메일이 로그인할 Google 계정과 같은지 확인합니다. 지금은 `Jinid231@gmail.com`입니다. 다른 계정이면 그 문자열만 바꿉니다.
5. 이 폴더에서 `firebase deploy --only firestore:rules`로 규칙을 배포합니다. 규칙을 배포하지 않으면 페이지에서의 읽기와 쓰기가 거부됩니다. 서비스 계정 쓰기는 규칙을 지나갑니다.
6. 서비스 계정을 만들고 역할은 Cloud Datastore User로 둡니다. JSON 키 전체를 GitHub Actions 비밀값 `FIREBASE_SERVICE_ACCOUNT`에 넣습니다. 키 파일은 저장소에 넣지 않습니다.
7. 설정 페이지를 연 사람이 Google로 로그인하면 `config`를 고칠 수 있습니다. `state`는 페이지만 읽고, 검사가 씁니다.

`FIREBASE_SERVICE_ACCOUNT`가 없는 GitHub Actions 검사는 실패합니다. 그 값을 넣지 않은 로컬 실행은 예전처럼 `config.yaml`과 `state/slots.json`을 사용합니다.
