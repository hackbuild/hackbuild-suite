import { createApp } from 'vue'
import '@virgilvox/hackbuild-ui/tokens.css'
import '@virgilvox/hackbuild-ui/styles.css'
import App from './App.vue'
import { router } from './router'
import './suite.css'

// Fonts: the hosted build links the local font files, the single file build
// inlines them so it renders the same from file://.
if (__SINGLE__) await import('@virgilvox/hackbuild-ui/fonts-inline.css')
else await import('@virgilvox/hackbuild-ui/fonts-local.css')

createApp(App).use(router).mount('#app')
