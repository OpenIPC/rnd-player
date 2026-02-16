// Temporary: exposes mp4box on window for the WebCodecs probe test.
// Load via <script type="module" src="/src/expose-mp4box.ts">
import { createFile, DataStream, Endianness } from "mp4box";
(window as any).__mp4box = { createFile, DataStream, Endianness };
