fn main() {
    std::process::exit(process_boundary(|| krx_cli::run_from(std::env::args_os())));
}

fn process_boundary(run: impl FnOnce() -> i32) -> i32 {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    std::panic::set_hook(previous_hook);
    match outcome {
        Ok(exit) => exit,
        Err(_) => {
            eprintln!("krx: error[internal/internal_failure]: native CLI failed internally");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;

    const PANIC_PROBE_ENV: &str = "KRX_CLI_PANIC_BOUNDARY_PROBE";
    const PANIC_SENTINEL: &str = "private panic detail";

    #[test]
    fn panic_boundary_is_stable_at_process_level() {
        if std::env::var_os(PANIC_PROBE_ENV).is_some() {
            std::process::exit(process_boundary(|| panic!("{PANIC_SENTINEL}")));
        }

        let output = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "tests::panic_boundary_is_stable_at_process_level",
                "--nocapture",
            ])
            .env(PANIC_PROBE_ENV, "1")
            .output()
            .expect("panic probe runs");
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(
            String::from_utf8(output.stderr).expect("UTF-8 diagnostic"),
            "krx: error[internal/internal_failure]: native CLI failed internally\n"
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains(PANIC_SENTINEL));
    }
}
