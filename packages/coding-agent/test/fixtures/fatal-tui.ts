import { ProcessTerminal, render } from "@oh-my-pi/pi-tui";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { FatalTuiView } from "./fatal-tui-view";

const theme = await getThemeByName("dark");
if (!theme) throw new Error("Expected dark theme");

render(FatalTuiView, { terminal: new ProcessTerminal(), theme });
