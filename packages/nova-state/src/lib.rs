mod brain;
mod index;
mod protocol;
mod source;

pub use brain::{BrainIndex, BrainIndexReport, BrainSearchHit};
pub use index::{IndexReport, SearchOptions, StateIndex};
pub use protocol::{handle_request, Request, Response, STATE_PROTOCOL_VERSION};
pub use source::{read_journal, read_session, SourceError};

// Corpus generators need the exact digest rule `read_session` verifies, never a second copy of it.
#[cfg(feature = "benchmark")]
pub use source::integrity_for_session;
