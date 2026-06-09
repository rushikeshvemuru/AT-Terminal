use std::ffi::CStr;
use std::os::unix::io::AsRawFd;

fn main() {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system.openpty(portable_pty::PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).unwrap();
    
    let master_fd = pair.master.as_raw_fd().unwrap();
    
    let name_ptr = unsafe { libc::ptsname(master_fd) };
    if !name_ptr.is_null() {
        let name = unsafe { CStr::from_ptr(name_ptr) }.to_string_lossy();
        println!("ptsname on master: {}", name);
    } else {
        println!("ptsname on master: NULL");
    }
    
    drop(pair);
}
