import app from "../../src/lib/i18n/catalogs/app/en.json";
import admin from "../../src/lib/i18n/catalogs/admin-dashboard/en.json";
// The app catalog adds keys inside module namespaces, as the message loader merges them.
const settings = { ...admin.settings, ...app.settings };
export const page = { data: { locale: "en", messages: { ...admin, ...app, settings } } };
