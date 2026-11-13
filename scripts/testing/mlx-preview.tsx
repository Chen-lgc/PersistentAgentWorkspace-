import { createRoot } from "react-dom/client";
import { MlxModels } from "../../src/components/MlxModels";
import { StoreProvider } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false);
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><div className="mx-auto max-w-3xl py-6"><MlxModels /></div></StoreProvider>);
