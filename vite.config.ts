import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ plugins:[vue()], clearScreen:false, server:{port:1420,strictPort:true,host:process.env.TAURI_DEV_HOST||'127.0.0.1',watch:{ignored:['**/src-tauri/**','**/.cache/**']}}, build:{target:'es2022',chunkSizeWarningLimit:1600}, resolve:{alias:{'@':new URL('./src',import.meta.url).pathname}} });
