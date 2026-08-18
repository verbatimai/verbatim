//! macOS resident memory measurement via task_info.

#[cfg(target_os = "macos")]
pub fn resident_mb() -> Result<f64, String> {
    use std::mem::{size_of, MaybeUninit};
    use std::ptr;

    #[repr(C)]
    struct TaskBasicInfo {
        suspend_count: u32,
        virtual_size: u64,
        resident_size: u64,
        user_time: TimeValue,
        system_time: TimeValue,
        policy: i32,
    }

    #[repr(C)]
    struct TimeValue {
        seconds: i32,
        microseconds: i32,
    }

    const TASK_BASIC_INFO: u32 = 20;
    const KERN_SUCCESS: i32 = 0;

    extern "C" {
        fn mach_task_self() -> u32;
        fn task_info(
            target_task: u32,
            flavor: u32,
            task_info_out: *mut TaskBasicInfo,
            task_info_out_cnt: *mut u32,
        ) -> i32;
    }

    unsafe {
        let mut info = MaybeUninit::<TaskBasicInfo>::uninit();
        let mut count = (size_of::<TaskBasicInfo>() / size_of::<u32>()) as u32;
        let kr = task_info(
            mach_task_self(),
            TASK_BASIC_INFO,
            info.as_mut_ptr(),
            &mut count,
        );
        if kr != KERN_SUCCESS {
            return Err(format!("task_info failed: {kr}"));
        }
        let info = info.assume_init();
        let bytes = info.resident_size as f64;
        Ok(bytes / (1024.0 * 1024.0))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn resident_mb() -> Result<f64, String> {
    Err("resident memory profiling is macOS-only".into())
}
