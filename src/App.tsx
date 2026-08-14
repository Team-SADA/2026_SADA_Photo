import { useEffect, useRef, useState } from "react";

type Algorithm = "obama" | "morph";
type Layout = "vertical";
type Mode = "celeb" | "friend";
type CapturedShot = { id: string; dataUrl: string; file: File };
type Page =
  | "home"
  | "select"
  | "select-algorithm"
  | "algorithm"
  | "mode"
  | "target"
  | "capture"
  | "processing"
  | "printing"
  | "result";

// The React app and Flask server share the same origin during local development.
// Leave empty when this React app and Flask are served from the same origin.
// During `npm start`, package.json proxies these requests to Flask on port 5000.
const OBAMIFY_API_BASE_URL = "";
const SADANECUT_UPLOAD_PATH = "/api/send_sadanecut";
const CAPTURE_DELAY_MS = 10_000;
const PROCESSING_DELAY_MS = 4_500;
const GIF_POLL_INTERVAL_MS = 1_000;
// Obamify may take longer on its first run while the model is loading.
const GIF_POLL_ATTEMPTS = 300;
const PAGE_TIMEOUT_MS = 60_000;
const CAPTURE_TIMEOUT_MS = 80_000;
const TIMED_PAGES: Page[] = ["select", "algorithm", "select-algorithm", "capture"];
const CAPTURE_COUNT = 8;
const MORPH_GIF_FRAME_COUNT = 24;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const buildApiUrl = (path: string) => `${OBAMIFY_API_BASE_URL}${path}`;

const makePhotoFile = (blob: Blob, shotNumber: number) => {
  const fileName = `photo-shot-${shotNumber}-${Date.now()}.jpg`;
  return new File([blob], fileName, { type: blob.type || "image/jpeg" });
};

/** Creates the two in-between frames used by the four-cut morph layout. */
const createMorphFrames = async (first: CapturedShot, second: CapturedShot) => {
  const load = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  const [a, b] = await Promise.all([load(first.dataUrl), load(second.dataUrl)]);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(a.naturalWidth, b.naturalWidth);
  canvas.height = Math.max(a.naturalHeight, b.naturalHeight);
  const context = canvas.getContext("2d");
  if (!context) return [];

  const drawCover = (image: HTMLImageElement) => {
    const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  };

  return Array.from({ length: MORPH_GIF_FRAME_COUNT }, (_, index) => {
    const progress = index / (MORPH_GIF_FRAME_COUNT - 1);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.globalAlpha = 1;
    drawCover(a);
    context.globalAlpha = progress;
    drawCover(b);
    context.globalAlpha = 1;
    return canvas.toDataURL("image/jpeg", 0.92);
  });
};

const createFourCutJpeg = async (
  images: string[],
  layout: Layout,
): Promise<File> => {
  const loaded = await Promise.all(
    images.map(
      (src) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        }),
    ),
  );
  const canvas = document.createElement("canvas");
  const width = 720;
  const gap = 12;
  const cellWidth = width;
  const cellHeight = 480;
  canvas.width = width;
  canvas.height = cellHeight * 4 + gap * 5;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create the four-cut canvas.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  loaded.forEach((image, index) => {
    const column = 0;
    const row = index;
    const x = gap + column * (cellWidth + gap);
    const y = gap + row * (cellHeight + gap);
    const scale = Math.max(cellWidth / image.naturalWidth, cellHeight / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    context.drawImage(image, x + (cellWidth - drawWidth) / 2, y + (cellHeight - drawHeight) / 2, drawWidth, drawHeight);
  });

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("Could not encode the four-cut JPEG.");
  return new File([blob], `morph-four-cut-${Date.now()}.jpg`, { type: "image/jpeg" });
};

const createSadaFrameJpeg = async (originals: string[], processedFrames: string[]) => {
  const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
  const [template, ...photos] = await Promise.all([
    load("/images/sada-eightcut-frame.png"),
    ...originals.map(load),
    ...processedFrames.map(load),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 1800;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create the SADA frame.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 1200, 1800);
  context.drawImage(template, 0, 0, 1200, 1800);
  const slots = [120, 540, 960, 1380].flatMap((top) => [[20, top], [620, top]]);
  const sourcePhotos = photos.slice(0, 4);
  const resultPhotos = photos.slice(4);
  slots.forEach(([left, top], index) => {
    const photo = index % 2 === 0 ? sourcePhotos[index / 2] : resultPhotos[(index - 1) / 2];
    const scale = Math.max(560 / photo.naturalWidth, 400 / photo.naturalHeight);
    const width = photo.naturalWidth * scale;
    const height = photo.naturalHeight * scale;
    context.save();
    context.beginPath();
    context.rect(left, top, 560, 400);
    context.clip();
    context.drawImage(photo, left + 280 - width / 2, top + 200 - height / 2, width, height);
    context.restore();
  });
  const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
  const blob = await (await fetch(dataUrl)).blob();
  return { dataUrl, file: new File([blob], `sada-fourcut-${Date.now()}.jpg`, { type: "image/jpeg" }) };
};

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 5h3l2-2h6l2 2h3a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm8 3a4 4 0 100 8 4 4 0 000-8z" />
  </svg>
);
const Placeholder = ({ label = "" }: { label?: string }) => (
  <div className="ph">
    <CameraIcon />
    {label && <span>{label}</span>}
  </div>
);

export default function App() {
  // ---------------------------------------------------------------------------
  // Navigation and session state
  // ---------------------------------------------------------------------------
  const [page, setPage] = useState<Page>("home");
  const [history, setHistory] = useState<Page[]>(["home"]);
  const [algorithm, setAlgorithm] = useState<Algorithm | null>(null);
  const [layout, setLayout] = useState<Layout>("vertical");
  const [mode, setMode] = useState<Mode | null>(null);
  const [people, setPeople] = useState(1);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [target, setTarget] = useState<number | null>(null);
  const [shots, setShots] = useState(0);
  const [capturedShots, setCapturedShots] = useState<CapturedShot[]>([]);
  const [selectedShotIds, setSelectedShotIds] = useState<string[]>([]);
  const [algorithmShotIds, setAlgorithmShotIds] = useState<string[]>([]);
  const [morphFrames, setMorphFrames] = useState<string[]>([]);
  const [generatedGifUrl, setGeneratedGifUrl] = useState<string | null>(null);
  const [generatedFourCutUrl, setGeneratedFourCutUrl] = useState<string | null>(null);
  const [generatedFourCutFrames, setGeneratedFourCutFrames] = useState<string[]>([]);
  const [generatedSadaPaperUrl, setGeneratedSadaPaperUrl] = useState<string | null>(null);
  const [generatedSadaPaperFile, setGeneratedSadaPaperFile] = useState<File | null>(null);
  const [generatedGifFilename, setGeneratedGifFilename] = useState<string | null>(null);
  const [gifError, setGifError] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [hasUploaded, setHasUploaded] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(60);
  const [isFlashing, setIsFlashing] = useState(false);
  const [printStatus, setPrintStatus] = useState<"printing" | "complete" | "error">("printing");
  const printCount = 1;
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const uploadLockedRef = useRef(false);

  const navigate = (next: Page) => {
    setHistory((value) => [...value, next]);
    setPage(next);
    window.scrollTo(0, 0);
  };
  const back = () =>
    setHistory((value) => {
      if (value.length < 2) return value;
      const next = value.slice(0, -1);
      setPage(next[next.length - 1]);
      return next;
    });
  const home = () => {
    stopCamera();
    setAlgorithm(null);
    setLayout("vertical");
    setMode(null);
    setPeople(1);
    setTarget(null);
    setShots(0);
    setCapturedShots([]);
    setSelectedShotIds([]);
    setAlgorithmShotIds([]);
    setMorphFrames([]);
    setGeneratedGifUrl(null);
    setGeneratedFourCutUrl(null);
    setGeneratedFourCutFrames([]);
    setGeneratedSadaPaperUrl(null);
    setGeneratedSadaPaperFile(null);
    setGeneratedGifFilename(null);
    setGifError(null);
    setResults([]);
    setDoneMessage(null);
    setHasUploaded(false);
    uploadLockedRef.current = false;
    setHistory(["home"]);
    setPage("home");
  };
  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => () => stopCamera(), []);
  useEffect(() => {
    if (!TIMED_PAGES.includes(page)) return;
    const timeoutMilliseconds = page === "capture" ? CAPTURE_TIMEOUT_MS : PAGE_TIMEOUT_MS;
    setSecondsRemaining(timeoutMilliseconds / 1000);
    const timer = window.setInterval(() => {
      setSecondsRemaining((seconds) => {
        if (seconds <= 1) {
          window.clearInterval(timer);
          if (page === "capture") {
            stopCamera();
            navigate("select");
          } else {
            home();
          }
          return 0;
        }
        return seconds - 1;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [page]);
  useEffect(() => {
    if (page !== "capture") return;
    let alive = true;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((stream) => {
        if (!alive) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      stopCamera();
    };
  }, [page]);

  useEffect(() => {
    if (page !== "capture") return;
    const timer = window.setTimeout(() => takeShot(), CAPTURE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [page, shots, people]);
  useEffect(() => {
    if (page !== "capture") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      void takeShot();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page, shots]);
  useEffect(() => {
    if (page !== "processing") return;
    if (algorithm === "obama") return;
    if (algorithm === "morph" && morphFrames.length < 2) return;
    const timer = window.setTimeout(() => navigate("result"), PROCESSING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [page, mode, algorithm, morphFrames.length]);

  // ---------------------------------------------------------------------------
  // Obamify GIF flow
  // ---------------------------------------------------------------------------
  const waitForFriendGif = async (userId: string) => {
    const url = buildApiUrl(`/gif/${encodeURIComponent(userId)}.gif`);
    for (let attempt = 0; attempt < GIF_POLL_ATTEMPTS; attempt += 1) {
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (response.ok) {
        // HEAD only confirms that the path exists. Read the body so the
        // result screen opens only after the complete GIF is available.
        const gifResponse = await fetch(url, { cache: "no-store" });
        const gif = await gifResponse.blob();
        if (gifResponse.ok && gif.size > 0) return url;
      }
      await sleep(GIF_POLL_INTERVAL_MS);
    }
    throw new Error("GIF generation timed out.");
  };
  const createFriendObamifyGif = async (source: CapturedShot, target: CapturedShot) => {
    const userId = `friend-${Date.now()}`;

    const formData = new FormData();
    formData.append("source", source.file);
    formData.append("target", target.file);
    formData.append("user_id", userId);

    try {
      const response = await fetch(buildApiUrl("/upload_images"), {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error(`Obamify upload failed: ${response.status}`);
      const gifUrl = await waitForFriendGif(userId);
      setGeneratedGifFilename(`${userId}.gif`);
      setGeneratedGifUrl(gifUrl);
      setGeneratedFourCutUrl(buildApiUrl(`/fourcut/${encodeURIComponent(userId)}-fourcut.jpg`));
      const frameUrls = [0, 1, 2, 3].map((index) => buildApiUrl(`/gif/${encodeURIComponent(userId)}-frame-${index}.jpg`));
      setGeneratedFourCutFrames(frameUrls);
      const originals = selectedShotIds
        .map((id) => capturedShots.find((shot) => shot.id === id)?.dataUrl)
        .filter((url): url is string => Boolean(url));
      const paper = await createSadaFrameJpeg(originals, frameUrls);
      setGeneratedSadaPaperUrl(paper.dataUrl);
      setGeneratedSadaPaperFile(paper.file);
      // Only now expose the student ID field and upload action.
      navigate("result");
    } catch (error) {
      console.error("Could not create the friend Obamify GIF.", error);
      setGifError("GIF 생성에 실패했습니다. Obamify 서버 실행 상태를 확인해 주세요.");
    }
  };

  // ---------------------------------------------------------------------------
  // Camera and captured-photo helpers
  // ---------------------------------------------------------------------------
  const takeShot = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    setIsFlashing(true);
    window.setTimeout(() => setIsFlashing(false), 180);

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92),
    );
    if (!imageBlob) return;

    const file = makePhotoFile(imageBlob, shots + 1);
    const capturedShot = {
      id: file.name,
      dataUrl: canvas.toDataURL("image/jpeg", 0.92),
      file,
    };

    setCapturedShots((value) => [...value, capturedShot]);
    const next = shots + 1;
    setShots(next);
    if (next >= CAPTURE_COUNT) {
      stopCamera();
      navigate("select");
    }
  };
  const downloadShots = () => {
    capturedShots.forEach((shot, index) => {
      const link = document.createElement("a");
      link.href = shot.dataUrl;
      link.download = `photo-shot-${index + 1}.jpg`;
      link.click();
    });
  };

  // ---------------------------------------------------------------------------
  // Target search and mode selection
  // ---------------------------------------------------------------------------
  const ShotPreview = ({ index }: { index: number }) => {
    const shot = capturedShots[index];
    return shot ? <img className="shot-preview" src={shot.dataUrl} alt={`촬영 사진 ${index + 1}`} /> : <Placeholder />;
  };
  const search = () => {
    const term = query.trim();
    if (!term) return;
    setTarget(null);
    setResults(Array.from({ length: 6 }, (_, index) => `${term} ${index + 1}`));
  };
  const submitPair = () => {
    if (!pairCode.trim()) return;
    setPairOpen(false);
    setQuery("");
    setTarget(null);
    setResults(["포토부스에서 고른 사진"]);
  };
  const chooseMode = (next: Mode) => {
    setMode(next);
    setPeople(next === "friend" || algorithm === "morph" ? 2 : 1);
  };
  const startAfterMode = () => {
    if (!mode) return;
    navigate(mode === "celeb" ? "target" : "capture");
  };
  const runSelectedAlgorithm = () => {
    if (!algorithm || algorithmShotIds.length !== 2) return;
    const pair = algorithmShotIds
      .map((id) => capturedShots.find((shot) => shot.id === id))
      .filter((shot): shot is CapturedShot => Boolean(shot));
    if (pair.length !== 2) return;
    navigate("processing");
    if (algorithm === "obama") {
      void createFriendObamifyGif(pair[0], pair[1]);
    } else {
      void createMorphFrames(pair[0], pair[1]).then(async (frames) => {
        const originals = selectedShotIds
          .map((id) => capturedShots.find((shot) => shot.id === id)?.dataUrl)
          .filter((url): url is string => Boolean(url));
        const paper = await createSadaFrameJpeg(
          originals,
          [frames[0], frames[8], frames[15], frames[MORPH_GIF_FRAME_COUNT - 1]],
        );
        setGeneratedSadaPaperUrl(paper.dataUrl);
        setGeneratedSadaPaperFile(paper.file);
        const formData = new FormData();
        formData.append("user_id", `morph-${Date.now()}`);
        const frameBlobs = await Promise.all(frames.map(async (frame, index) => ({
          blob: await (await fetch(frame)).blob(),
          index,
        })));
        frameBlobs.forEach(({ blob, index }) => formData.append("frames", new File([blob], `morph-${index}.jpg`, { type: "image/jpeg" })));
        const gifResponse = await fetch(buildApiUrl("/api/create_morph_gif"), { method: "POST", body: formData });
        if (!gifResponse.ok) throw new Error("Could not create the morph GIF.");
        const gif = await gifResponse.json();
        setGeneratedGifFilename(gif.filename);
        setGeneratedGifUrl(buildApiUrl(gif.url));
        setMorphFrames(frames);
      });
    }
  };
  const upload = async (form: HTMLFormElement) => {
    const id = new FormData(form)
      .get("socialId")
      ?.toString()
      .trim();
    if (!id || uploadLockedRef.current) return;
    uploadLockedRef.current = true;
    setHasUploaded(true);
    if (algorithm === "morph") {
      try {
        const imageSources = [capturedShots[0]?.dataUrl, morphFrames[0], morphFrames[1], capturedShots[1]?.dataUrl];
        if (imageSources.some((source) => !source)) throw new Error("Morph images are not ready yet.");
        const printFile = generatedSadaPaperFile || await createFourCutJpeg(imageSources as string[], layout);
        const formData = new FormData();
        formData.append("student_id", id);
        formData.append("image", printFile);
        if (generatedGifUrl && generatedGifFilename) {
          const gifBlob = await (await fetch(generatedGifUrl)).blob();
          formData.append("gif", new File([gifBlob], generatedGifFilename, { type: "image/gif" }));
        }
        const response = await fetch(buildApiUrl("/api/send_sadanecut_file"), { method: "POST", body: formData });
        if (!response.ok) throw new Error(`SADA upload failed: ${response.status}`);
        setDoneMessage(`${id} morph four-cut JPEG uploaded.`);
      } catch (error) {
        setDoneMessage(`Morph upload failed. ${error instanceof Error ? error.message : "Check the SADA API response."}`);
      }
      return;
    }
    if (algorithm === "obama") {
      if (!generatedGifFilename || !generatedGifUrl || !generatedSadaPaperFile) {
        setDoneMessage("아직 전송할 GIF가 없습니다. GIF 생성이 끝난 뒤 다시 시도해 주세요.");
        return;
      }

      const formData = new FormData();
      formData.append("student_id", id);

      try {
        const [paperResponse, gifResponse] = await Promise.all([
          fetch(generatedFourCutUrl || ""),
          fetch(generatedGifUrl || ""),
        ]);
        formData.append("image", generatedSadaPaperFile || new File([await paperResponse.blob()], `${generatedGifFilename}-fourcut.jpg`, { type: "image/jpeg" }));
        formData.append("gif", new File([await gifResponse.blob()], generatedGifFilename, { type: "image/gif" }));
        const response = await fetch(buildApiUrl("/api/send_sadanecut_file"), {
          method: "POST",
          body: formData,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          const reason = body?.response || body?.error || `HTTP ${response.status}`;
          throw new Error(`SADA upload failed: ${JSON.stringify(reason)}`);
        }
        setDoneMessage(`${id} 학번으로 GIF를 전송했습니다.`);
      } catch (error) {
        console.error("Could not upload the Obamify GIF.", error);
        setDoneMessage("GIF 전송에 실패했습니다. 백엔드와 SADA API 응답을 확인해 주세요.");
      }
      return;
    }
    const kind = "모프 사진";
    setDoneMessage(
      `${id} 계정으로 ${kind}을 보냈어요.${printCount > 0 ? ` 인화용 사진 ${printCount}장을 출력할 수 있어요.` : ""}`,
    );
  };
  const startPrint = async () => {
    navigate("printing");
    if (!generatedSadaPaperFile) {
      setPrintStatus("error");
      return;
    }
    setPrintStatus("printing");
    const formData = new FormData();
    formData.append("image", generatedSadaPaperFile);
    formData.append("copies", String(printCount));
    try {
      const response = await fetch(buildApiUrl("/api/print"), { method: "POST", body: formData });
      if (!response.ok) throw new Error("Print request failed.");
      setPrintStatus("complete");
    } catch (error) {
      console.error("Could not send the print request.", error);
      setPrintStatus("error");
    }
  };

  // ---------------------------------------------------------------------------
  // Shared UI building blocks
  // ---------------------------------------------------------------------------
  const Header = ({ action }: { action?: React.ReactNode }) => (
    <header className="bar">
      {TIMED_PAGES.includes(page) && (
        <div className="countdown" aria-label={`${secondsRemaining}초 남음`}>
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle className="countdown-track" cx="18" cy="18" r="15" />
            <circle
              className="countdown-progress"
              cx="18"
              cy="18"
              r="15"
              style={{
                strokeDashoffset:
                  94.25 * (1 - secondsRemaining / (page === "capture" ? CAPTURE_TIMEOUT_MS / 1000 : PAGE_TIMEOUT_MS / 1000)),
              }}
            />
          </svg>
          <span>{secondsRemaining}</span>
        </div>
      )}
      {false && (
        <button className="pill ghost" onClick={back}>
          ← 뒤로 가기
        </button>
      )}
      <span className="spacer" />
      {action}
    </header>
  );
  const LayoutSelector = () => (
    <div className="chips" style={{ display: "none" }}>
      <button
        className={`chip ${layout === "vertical" ? "on" : ""}`}
        onClick={() => setLayout("vertical")}
      >
        세로형 · 1 × 4
      </button>
      <button
        className="chip"
        style={{ display: "none" }}
      >
        정사각형 · 2 × 2
      </button>
    </div>
  );

  let content: React.ReactNode;
  if (page === "home")
    content = (
      <>
        <Header />
        <main className="wrap">
          <section className="home">
            <div className="logo">싸다네컷!</div>
            <p className="sub">
              얼굴을 바꾸고, 한 컷으로 찍고, GIF로 간직하세요
            </p>
            <button
              className="btn home-button"
              onClick={() => navigate("capture")}
            >
              만들기
            </button>
          </section>
        </main>
      </>
    );
  else if (page === "select")
    content = (
      <>
        <Header />
        <main className="wrap">
          <h1>틀 왼쪽에 넣을 사진 네 장을 골라주세요</h1>
          <p className="sub">8장 중 정확히 4장을 선택합니다.</p>
          <div className="grid3 original-picker">
            {capturedShots.map((shot) => {
              const selected = selectedShotIds.includes(shot.id);
              return (
                <button
                  className={`cell ${selected ? "on" : ""}`}
                  key={shot.id}
                  onClick={() => setSelectedShotIds((ids) => {
                    if (ids.includes(shot.id)) return ids.filter((id) => id !== shot.id);
                    return ids.length < 4 ? [...ids, shot.id] : ids;
                  })}
                  >
                    <img className="shot-preview" src={shot.dataUrl} alt="촬영 사진" />
                    {selected && <span className="selection-order">{selectedShotIds.indexOf(shot.id) + 1}</span>}
                </button>
              );
            })}
          </div>
          <div className="right">
            <button className="btn" disabled={selectedShotIds.length !== 4} onClick={() => navigate("algorithm")}>다음</button>
          </div>
        </main>
      </>
    );
  else if (page === "algorithm")
    content = (
      <>
        <Header />
        <main className="wrap">
          <h1>어떻게 만들까요?</h1>
          <p className="sub">알고리즘에 따라 받는 결과물이 달라요.</p>
          <div className="cards2">
            <button
              className={`card ${algorithm === "obama" ? "on" : ""}`}
              onClick={() => setAlgorithm("obama")}
            >
              <div className="preview gif-preview">
                <img className="algorithm-preview-image" src="/images/obamify-preview.gif" alt="Obamify 예시 GIF" />
                <b className="gifbadge">GIF</b>
              </div>
              <b className="cn">Obamify</b>
              <p className="cd">Obamify는 이미지를 작은 조각으로 재배열하여, 가까이에서는 원본이 보이지만 멀리에서는 다른 이미지로 인식되도록 만드는 이미지 처리 기법입니다.</p>
              <span className="badge">GIF 파일</span>
            </button>
            <button
              className={`card ${algorithm === "morph" ? "on" : ""}`}
              onClick={() => setAlgorithm("morph")}
            >
              <div className="preview">
                <img className="algorithm-preview-image" src="/images/morphing-preview.gif" alt="Morphing 예시 GIF" />
              </div>
              <b className="cn">Morphing</b>
              <p className="cd">Image Morphing은 두 이미지의 형태와 색상을 점진적으로 변형하여, 하나의 이미지가 다른 이미지로 자연스럽게 변화하도록 만드는 이미지 처리 기법입니다.</p>
              <span className="badge">사진 파일</span>
            </button>
          </div>
          {false && algorithm === "morph" && (
            <>
              <p className="label">네 컷을 어떤 형태로 찍을까요?</p>
              <LayoutSelector />
            </>
          )}
          <div className="right">
            <button
              className="btn"
              disabled={!algorithm}
              onClick={() => navigate("select-algorithm")}
            >
              다음
            </button>
          </div>
        </main>
      </>
    );
  else if (page === "select-algorithm")
    content = (
      <>
        <Header />
        <main className="wrap">
          <h1>알고리즘에 사용할 사진 두 장을 골라주세요</h1>
          <p className="sub">8장 중 정확히 2장을 선택합니다.</p>
          <div className="algorithm-pair" aria-label="사진 변환 순서">
            {[0, 1].map((order) => {
              const shot = capturedShots.find((item) => item.id === algorithmShotIds[order]);
              return (
                <div className="algorithm-pair-photo" key={order}>
                  {shot ? <img src={shot.dataUrl} alt={`${order + 1}번 선택 사진`} /> : <Placeholder label={`${order + 1}번 선택`} />}
                </div>
              );
            }).reduce<React.ReactNode[]>((items, item, index) => {
              if (index) items.push(<span className="algorithm-arrow" key="arrow">→</span>);
              items.push(item);
              return items;
            }, [])}
          </div>
          <div className="grid3 algorithm-picker">
            {capturedShots.map((shot) => {
              const selected = algorithmShotIds.includes(shot.id);
              return (
                <button
                  className={`cell ${selected ? "on" : ""}`}
                  key={shot.id}
                  onClick={() => setAlgorithmShotIds((ids) => {
                    if (ids.includes(shot.id)) return ids.filter((id) => id !== shot.id);
                    return ids.length < 2 ? [...ids, shot.id] : ids;
                  })}
                  >
                    <img className="shot-preview" src={shot.dataUrl} alt="알고리즘 선택 사진" />
                    {selected && <span className="selection-order">{algorithmShotIds.indexOf(shot.id) + 1}</span>}
                </button>
              );
            })}
          </div>
          <div className="right">
            <button className="btn" disabled={algorithmShotIds.length !== 2} onClick={runSelectedAlgorithm}>실행</button>
          </div>
        </main>
      </>
    );
  else if (page === "mode") {
    const min = mode === "friend" ? 2 : 1;
    content = (
      <>
        <Header />
        <main className="wrap narrow">
          <h1>누구의 얼굴로 바꿀까요?</h1>
          <button
            className={`rowcard ${mode === "celeb" ? "on" : ""}`}
            onClick={() => chooseMode("celeb")}
          >
            <span className="ic">★</span>
            <span>
              <b className="cn">연예인과 바꾸기</b>
              <small className="cd">검색해서 고른 얼굴로 바꿔드려요.</small>
            </span>
          </button>
          <button
            className={`rowcard ${mode === "friend" ? "on" : ""}`}
            onClick={() => chooseMode("friend")}
          >
            <span className="ic">☺</span>
            <span>
              <b className="cn">친구와 바꾸기</b>
              <small className="cd">함께 찍은 얼굴을 서로 바꿔드려요.</small>
            </span>
          </button>
          {mode && (
            <>
              <p className="label">몇 명이 찍나요?</p>
              <p className="sub">한 명당 한 컷씩 찍어요.</p>
              <div className="chips people">
              {(mode === "friend" ? [2] : [1, 2, 3, 4])
                  .filter((number) => number >= min)
                  .map((number) => (
                    <button
                      key={number}
                      className={`chip ${people === number ? "on" : ""}`}
                      onClick={() => setPeople(number)}
                    >
                      {number}명
                    </button>
                  ))}
              </div>
            </>
          )}
          <div className="right">
            <button className="btn" disabled={!mode} onClick={startAfterMode}>
              다음
            </button>
          </div>
        </main>
      </>
    );
  } else if (page === "target")
    content = (
      <>
        <Header
          action={
            <button className="pill" onClick={() => setPairOpen(true)}>
              포토부스에서 가져오기
            </button>
          }
        />
        <main className="wrap">
          <h1>누구로 바꿀까요?</h1>
          <div className="search">
            <span>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && search()}
              placeholder="연예인 이름 또는 이미지 주소"
            />
            <button className="go" onClick={search}>
              →
            </button>
          </div>
          {results.length ? (
            <>
              <p className="sub result-count">{results.length}개 찾았어요.</p>
              <div className="grid3">
                {results.map((name, index) => (
                  <button
                    className={`cell ${target === index ? "on" : ""}`}
                    key={name}
                    onClick={() => setTarget(index)}
                  >
                    <Placeholder label={name} />
                    <span className="cn">{name}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="empty sub">이름을 검색해 보세요.</p>
          )}
          <div className="right">
            <button
              className="btn"
              disabled={target === null}
              onClick={() => navigate("capture")}
            >
              {target !== null
                ? `${results[target]}(으)로 찍기`
                : "얼굴을 골라주세요"}
            </button>
          </div>
        </main>
      </>
    );
  else if (page === "capture")
    content = (
      <>
        <Header />
        <main className="wrap narrow capwrap">
          <h1>
            {mode === "friend"
              ? `${String.fromCharCode(65 + shots)}번 친구 차례`
              : "정면을 봐주세요"}
          </h1>
          <div className="dots">
            {Array.from({ length: CAPTURE_COUNT }, (_, index) => (
              <i key={index} className={index < shots ? "on" : ""} />
            ))}
          </div>
            <div className="cambox">
              <video ref={videoRef} autoPlay playsInline muted />
              {isFlashing && <div className="camera-flash" aria-hidden="true" />}
            <button className="shutter" aria-label="촬영" onClick={takeShot}>
              ●
            </button>
          </div>
          <p className="shot-hint">
            10초 뒤 자동으로 촬영돼요. 버튼을 누르면 바로 촬영합니다.
          </p>
        </main>
      </>
    );
  else if (page === "printing")
    content = (
      <>
        <Header />
        <main className="wrap">
          <section className="proc">
            {printStatus === "printing" && <div className="spin" />}
            <h1>{printStatus === "printing" ? "사진을 출력하고 있습니다." : printStatus === "complete" ? "사진 출력이 완료되었습니다." : "사진 출력 요청에 실패했습니다."}</h1>
            <p className="sub">{printStatus === "printing" ? "SELPHY CP1500에서 인화가 진행됩니다." : "완료를 누르면 세션이 종료됩니다."}</p>
            {printStatus !== "printing" && <button className="btn" onClick={home}>완료</button>}
          </section>
        </main>
      </>
    );
  else if (page === "processing")
    content = (
      <>
        <Header />
        <main className="wrap">
          <section className="proc">
            <div className="spin" />
            <h1>
              {algorithm === "obama"
                ? "GIF로 만드는 중"
                : "모프 네 컷을 만드는 중"}
            </h1>
            <p className="sub">
              {gifError || (mode === "friend" ? "친구 사진 두 장으로 GIF를 만드는 중이에요." : "30초쯤 걸려요.")}
            </p>
          </section>
        </main>
      </>
    );
  else {
    // Both algorithms share one result layout; only the generated media differs.
    const gif = false;
    content = (
      <>
        <Header />
        <main className="wrap">
          <section className={`result ${gif ? "result-obama" : ""}`}>
            <div className="paper">
              {false ? (
                <div className="gif">
                  {generatedGifUrl ? <img className="shot-preview" src={generatedGifUrl || undefined} alt="생성된 Obamify GIF" /> : <ShotPreview index={0} />}
                  <b className="gifbadge">GIF</b>
                  {generatedFourCutUrl && (
                    <div className="fourcut-paper">
                      {generatedSadaPaperUrl ? (
                        <img className="sada-eightcut-preview" src={generatedSadaPaperUrl || undefined} alt="SADANECUT 결과" />
                      ) : (
                      <div className="fourV">
                        {generatedFourCutFrames.map((frame, index) => (
                          <img className="shot-preview" key={frame} src={frame} alt={`Obamify 네컷 ${index + 1}`} />
                        ))}
                      </div>
                      )}
                      <div className="papercap"><b>모프네컷</b><span>세로형 · 1 × 4</span></div>
                    </div>
                  )}
                </div>
              ) : (
                generatedSadaPaperUrl ? <img className="sada-eightcut-preview" src={generatedSadaPaperUrl} alt="SADANECUT 모프 결과" /> : <div className="fourV">
                  {[
                    capturedShots[0]?.dataUrl,
                    morphFrames[0],
                    morphFrames[1],
                    capturedShots[1]?.dataUrl,
                  ].map((src, index) =>
                    src ? (
                      <img className="shot-preview" key={index} src={src} alt={`紐⑦봽 ?ъ쭊 ${index + 1}`} />
                    ) : (
                      <Placeholder key={index} />
                    ),
                  )}
                </div>
              )}
              <div className="papercap">
                <b>오바미파이</b>
                <span>
                  {gif ? "" : "세로형"}
                </span>
              </div>
            </div>
            {!gif && generatedGifUrl && (
              <div className="morph-gif-preview">
                <img src={generatedGifUrl} alt="생성된 모핑 GIF" />
                <b className="gifbadge">GIF</b>
              </div>
            )}
            <form onSubmit={(event) => event.preventDefault()}>
              <p className="label top-label">소셜 로그인 아이디</p>
              <input
                className="textin"
                name="socialId"
                placeholder="아이디를 입력하면 결과물을 보내드려요"
              />
              {gif ? (
                <p className="gifnote">
                  GIF는 인화할 수 없어 계정으로 보내드릴게요.
                </p>
              ) : (
                <>
                  <p className="label">형태</p>
                  <LayoutSelector />
                </>
              )}
              <div className="actions">
                <button
                  className="btn"
                  type="button"
                  disabled={hasUploaded}
                  onClick={(event) => {
                    if (event.currentTarget.form) void upload(event.currentTarget.form);
                  }}
                >
                  업로드
                </button>
                <button className="btn ghost" type="button" onClick={() => void startPrint()}>
                  출력하고 마치기
                </button>
              </div>
            </form>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      {content}
      {pairOpen && (
        <div className="mask">
          <div className="dialog">
            <h2>포토부스 화면의 6자리 코드</h2>
            <input
              className="code"
              maxLength={6}
              value={pairCode}
              onChange={(event) => setPairCode(event.target.value)}
              placeholder="------"
            />
            <div className="actions">
              <button className="btn ghost" onClick={() => setPairOpen(false)}>
                취소
              </button>
              <button className="btn" onClick={submitPair}>
                가져오기
              </button>
            </div>
          </div>
        </div>
      )}
      {doneMessage && (
        <div className="mask">
          <div className="dialog">
            <h2>안내</h2>
            <p className="sub">{doneMessage}</p>
            <div className="right">
              <button
                className="btn"
                onClick={() => {
                  setDoneMessage(null);
                }}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
