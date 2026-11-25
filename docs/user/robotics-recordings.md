# Inspect and annotate a Rerun recording

Open an `.rrd` file from the conversation file panel in the web or desktop
client. The environment streams the original file to the embedded Rerun viewer.
Use its timeline and entity views to locate the evidence.

Pause on the event, select the relevant entities, and choose **Annotate**.
Write your observation and choose **Add to chat**. For a recording in the
project or conversation worktree, this saves a note against the recording
version you viewed and adds its ID and location to the current chat draft.
Review and send the draft when ready. A conversation in the same project can
use `t3_robotics_annotation_get` to retrieve the note by ID.

For a recording outside those folders, the viewer can put the selection and
comment into the chat draft. Saving a note requires file read access and
permission to operate conversations on that environment.
