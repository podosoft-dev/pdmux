import { mount } from "svelte";
import "./harness.css";
import "@pdmux/ui/styles.css";
import Harness from "./Harness.svelte";
const target = document.getElementById("app");
if (target) mount(Harness, { target });
