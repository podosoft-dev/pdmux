import app from "../../src/lib/i18n/catalogs/app/en.json";
import admin from "../../src/lib/i18n/catalogs/admin-dashboard/en.json";
export const page = { data: { locale: "en", messages: { ...admin, ...app } } };
