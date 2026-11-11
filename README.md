# 2026 사다네컷 포토부스

카메라로 촬영한 사진을 골라 사다네컷 인화용 이미지와 GIF를 만드는 Windows 포토부스입니다. 촬영 화면에서 Obamify 또는 Image Morphing을 선택할 수 있으며, 완성된 사진을 부스 프린터로 출력하거나 SADA 서비스로 전송할 수 있습니다.

## 프로그램 구성

| 경로 | 역할 |
| --- | --- |
| [`src/`](src/) | React·TypeScript 부스 화면. 카메라 촬영, 사진 선택, 결과 미리보기, 출력 및 전송을 담당합니다. |
| [`public/images/`](public/images/) | 인화용 프레임과 알고리즘 미리보기 이미지입니다. |
| [`Backend/app.py`](Backend/app.py) | Flask API. 사진과 GIF 저장, Obamify 실행, 모핑 GIF 인코딩, Windows 프린터 출력, SADA 전송을 처리합니다. |
| [`obamify/`](obamify/) | Rust·wgpu 기반 이미지 변환 프로그램입니다. Flask가 실행 파일을 `--auto`로 시작하면 이미지를 가져와 변환하고, 완성된 GIF를 Flask에 돌려줍니다. |
| [`morphing/`](morphing/) | 별도로 열어볼 수 있는 이미지 모핑 데모입니다. 부스의 모핑 경로는 React 화면에서 중간 프레임을 만들고 Flask에서 GIF로 인코딩합니다. |

## Windows에서 실행하기

Node.js와 npm, Python, Rust 도구가 필요합니다. 촬영에는 카메라가 필요하며, 실물 인화에는 Windows에 등록된 프린터가 필요합니다.

저장소 루트에서 의존성을 설치합니다.

```powershell
npm.cmd ci
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r Backend/requirements.txt
```

Obamify를 사용할 경우 Rust 프로그램을 먼저 빌드합니다. Flask는 `obamify/target/release/obamify.exe`를 우선 찾습니다.

```powershell
Push-Location obamify
cargo build --release
Pop-Location
```

첫 번째 터미널에서 Flask를 실행합니다.

```powershell
.\.venv\Scripts\python.exe Backend/app.py
```

두 번째 터미널에서 React 개발 서버를 실행한 뒤 `http://localhost:3000`을 엽니다. React 개발 서버는 API 요청을 `http://127.0.0.1:5000`의 Flask로 전달합니다.

```powershell
npm.cmd start
```

프런트엔드 정적 빌드는 `npm.cmd run build`로 `build/`에 생성됩니다. 정적 빌드를 서비스할 때는 같은 출처에서 Flask API 경로를 제공해야 합니다.

## 부스 설정과 저장 위치

| 환경 변수 | 용도 |
| --- | --- |
| `SELPHY_PRINTER_NAME` | Windows에 등록된 프린터 이름입니다. 기본값은 `Canon SELPHY CP1500`입니다. |
| `SADANECUT_BOOTH_KEY` | SADA 서비스로 사진과 GIF를 전송할 때 사용하는 키입니다. 전송 기능을 사용할 경우 Flask를 시작하는 터미널에 설정합니다. |

원본 사진, 생성 이미지와 GIF, 작업 로그는 `Backend/images/` 아래 작업별 폴더에 저장됩니다. 이 폴더와 `.venv/`는 Git에서 제외됩니다.

## 부스 확인 항목

1. 브라우저에서 카메라를 허용하고 촬영한 뒤, 인화 틀에 넣을 사진을 선택합니다.
2. Image Morphing과 Obamify를 각각 선택해 결과 미리보기와 GIF가 표시되는지 확인합니다.
3. 프린터가 연결된 부스에서 인화 매수를 1장으로 선택하고, 실제 출력물의 방향과 잘림을 확인합니다.
4. SADA 전송을 사용하는 부스에서는 테스트용 6자리 코드로 사진과 GIF가 도착하는지 확인합니다.
