import { mount } from 'svelte';
import '../../src/styles.css';
import Bench from './Bench.svelte';

const target = document.getElementById('app');
if (target) mount(Bench, { target });
