// Public share bundle entry, served as /s/<token>. Deliberately framework-free:
// no Vue, no PrimeVue, no router, so it shares no chunk with the admin SPA and
// stays a few kilobytes. All logic lives in ./share/ where it is unit tested.
import "./share/share.css";
import { mountShare } from "./share/mount.ts";

mountShare(document, window.location.pathname);
