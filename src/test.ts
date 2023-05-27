import { cpus } from 'os'
import { ChartsScanner } from "./main";

const scanner = new ChartsScanner(cpus().length - 1)
scanner.scan('D:/Clone Hero/').then(res => console.log(res))
