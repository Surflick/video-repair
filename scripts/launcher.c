#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int is_file(const char *p) {
  struct stat st;
  return p && stat(p, &st) == 0 && S_ISREG(st.st_mode);
}

/* Video Repair.app lives inside the project folder:
 *   <root>/Video Repair.app/Contents/MacOS/VideoRepair
 */
static int project_root(char *out, size_t cap) {
  char exe[PATH_MAX];
  uint32_t n = sizeof(exe);
  if (_NSGetExecutablePath(exe, &n) != 0) return -1;

  char resolved[PATH_MAX];
  if (!realpath(exe, resolved)) {
    strncpy(resolved, exe, sizeof(resolved) - 1);
    resolved[sizeof(resolved) - 1] = '\0';
  }

  char *marker = strstr(resolved, "/Video Repair.app/Contents/MacOS/");
  if (!marker) return -1;
  *marker = '\0';
  if (!resolved[0]) return -1;
  if (strlen(resolved) + 1 > cap) return -1;
  memcpy(out, resolved, strlen(resolved) + 1);
  return 0;
}

int main(void) {
  char root[PATH_MAX];
  if (project_root(root, sizeof(root)) != 0) {
    fprintf(stderr, "Keep Video Repair.app inside the Video Repair folder.\n");
    return 1;
  }

  char script[PATH_MAX];
  if (snprintf(script, sizeof(script), "%s/scripts/mac-open.sh", root) >= (int)sizeof(script)) {
    return 1;
  }
  if (!is_file(script)) {
    fprintf(stderr, "Cannot find %s\n", script);
    return 1;
  }

  execl("/bin/bash", "bash", script, (char *)NULL);
  perror("Video Repair");
  return 1;
}
