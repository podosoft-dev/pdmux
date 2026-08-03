import { mount } from 'svelte';
import '../../src/styles.css';
import Harness from './Harness.svelte';

const target = document.getElementById('app');
if (target) mount(Harness, { target });
