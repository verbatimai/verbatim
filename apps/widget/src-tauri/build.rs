fn main() {
    println!("cargo::rustc-check-cfg=cfg(nemo_speech_linked)");
    tauri_build::build();

    // Link NeMo-Speech.cpp when building with --features nemotron and NEMO_SPEECH_PREFIX set.
    // Example:
    //   NEMO_SPEECH_PREFIX=$HOME/nemo-speech cargo build -p verbatim-widget --features nemotron
    if std::env::var("CARGO_FEATURE_NEMOTRON").is_ok() {
        if let Ok(prefix) = std::env::var("NEMO_SPEECH_PREFIX") {
            let lib_dir = format!("{prefix}/lib");
            println!("cargo:rustc-link-search=native={lib_dir}");
            println!("cargo:rustc-link-lib=dylib=nemo_speech_asr_c");
            // RPATH so the dylib resolves at runtime relative to the installed SDK lib/.
            println!("cargo:rustc-link-arg=-Wl,-rpath,{lib_dir}");
            println!("cargo:rustc-cfg=nemo_speech_linked");
            println!("cargo:rerun-if-env-changed=NEMO_SPEECH_PREFIX");
        } else {
            println!("cargo:warning=feature nemotron enabled but NEMO_SPEECH_PREFIX unset — building stub ASR");
        }
    }
}
