// The admin settings registry imports components that read the page; tests never render them.
export const page = { data: {}, url: new URL("http://localhost/"), params: {}, status: 200 };
export const navigating = { current: null };
export const updated = { current: false };
